// 上传端点（/dsh-kit/upload）辅助：multipart/form-data 手工解析（零依赖）。
// 只覆盖浏览器 FormData 的标准形态：整体缓冲后按 boundary 切分，提取各 part 的
// filename 与数据；filename*（RFC 5987 URL 编码 UTF-8）优先，回退 filename。
// 单独成模块：宿主侧 index.ts 消费，tests/test-upload.mjs 单测。
import path from 'node:path';
/** 从 Content-Type 头取 boundary；非 multipart/form-data 或缺 boundary 返回 null */
export function multipartBoundary(contentType) {
    if (typeof contentType !== 'string')
        return null;
    const m = /multipart\/form-data[^;]*;.*boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
    if (!m)
        return null;
    const b = (m[1] ?? m[2] ?? '').trim();
    return b === '' ? null : b;
}
/** 解析 multipart body（整体 Buffer）为 [{ filename, data:Buffer }]。
 *  边界行以 \r\n--boundary 定位（body 开头的裸 --boundary 也认）——裸串搜
 *  "--boundary" 会把内容里恰好出现的同款字样误切。只取带 filename 的 part；
 *  filename*（RFC 5987）优先，回退 filename。解析不了的 part 静默跳过。 */
export function parseMultipart(body, boundary) {
    const parts = [];
    if (!Buffer.isBuffer(body) || typeof boundary !== 'string' || boundary === '')
        return parts;
    const dash = Buffer.from(`--${boundary}`);
    const crlfDash = Buffer.from(`\r\n--${boundary}`);
    const starts = [];
    if (body.length >= dash.length && body.subarray(0, dash.length).equals(dash))
        starts.push(0);
    let i = body.indexOf(crlfDash);
    while (i !== -1) {
        starts.push(i + 2);
        i = body.indexOf(crlfDash, i + 1);
    }
    for (let k = 0; k < starts.length; k++) {
        const s = starts[k];
        // part 内容终点 = 下一边界行的 CRLF 之前；末段以收尾边界为界
        const e = k + 1 < starts.length ? starts[k + 1] - 2 : body.length;
        let segStart = s + dash.length;
        if (body.length >= segStart + 2 && body[segStart] === 0x2d && body[segStart + 1] === 0x2d)
            break; // "--" 终止
        if (body.length >= segStart + 2 && body[segStart] === 0x0d && body[segStart + 1] === 0x0a)
            segStart += 2;
        let segEnd = e;
        if (segEnd >= segStart + 2 && body[segEnd - 2] === 0x0d && body[segEnd - 1] === 0x0a)
            segEnd -= 2;
        if (segEnd <= segStart)
            continue;
        const seg = body.subarray(segStart, segEnd);
        const headEnd = seg.indexOf('\r\n\r\n');
        if (headEnd === -1)
            continue;
        const head = seg.subarray(0, headEnd).toString('utf8');
        const data = seg.subarray(headEnd + 4);
        const dispo = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
        const star = /filename\*=(?:utf-8|UTF-8)''([^;\r\n]+)/.exec(dispo);
        const plain = /filename="([^"]*)"/.exec(dispo) ?? /filename=([^;\r\n"]+)/.exec(dispo);
        let filename = '';
        if (star) {
            try {
                filename = decodeURIComponent(star[1] ?? '');
            }
            catch {
                filename = star[1] ?? '';
            }
        }
        else if (plain) {
            filename = plain[1] ?? '';
        }
        if (filename !== '')
            parts.push({ filename, data });
    }
    return parts;
}
/** 上传文件落盘名：取 basename、去控制字符与 Windows 非法字符、限长（保尾部）；
 *  非法（空/点目录）返回 null */
export function safeUploadName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '').trim();
    if (cleaned === '' || cleaned === '.' || cleaned === '..')
        return null;
    return cleaned.length > 120 ? cleaned.slice(cleaned.length - 120) : cleaned;
}
/** 目标已存在时不覆盖：在扩展名前追加 " (n)" 序号；1..999 全占返回 null。
 *  existsSync 注入便于单测。 */
export function dedupeName(dir, name, existsSync) {
    if (!existsSync(path.join(dir, name)))
        return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; n < 1000; n++) {
        const cand = `${stem} (${n})${ext}`;
        if (!existsSync(path.join(dir, cand)))
            return cand;
    }
    return null;
}
