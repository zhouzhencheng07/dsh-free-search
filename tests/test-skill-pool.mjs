// 技能池端点端到端测试（针对运行中的 dsh web，默认 http://127.0.0.1:3081）
// 覆盖：三逻辑组结构、枚举（工作区聚合两根）、同名 shadowed 标注（rank 小者胜）、
//       复制、409 冲突+覆盖、移动、禁用/启用（frontmatter 双键）、删除=真删、
//       白名单外路径拒绝、同根操作拒绝。
// 用法：node tests\test-skill-pool.mjs [baseUrl]（需 dev 环境在跑，默认 http://127.0.0.1:3081）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:3081";
const POOL = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "skill-pool");
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS  " : "FAIL  "}${label}${!ok && detail ? ` :: ${detail}` : ""}`);
  if (!ok) failed++;
};

// ── fixture：临时项目目录（带 .git 标记）；同名 dup-kit 放两根验证 shadowed ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshkit-skill-"));
fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });

// 幂等清理：上次运行遗留在池里的同名技能（现在删除是真删，必须先清场）
for (const name of ["hello-kit", "flat-kit"]) {
  fs.rmSync(path.join(POOL, name), { recursive: true, force: true });
}
const mkSkill = (relDir, name, description) => {
  const dir = path.join(tmp, relDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return dir;
};
mkSkill(".agents/skills", "hello-kit", "目录型测试技能"); // rank 200
mkSkill(".dsh/skills", "dup-kit", "高优先级副本"); // rank 100
mkSkill(".agents/skills", "dup-kit", "低优先级副本"); // rank 200 → 应被标 shadowed

try {
  const listSkills = async () =>
    fetch(`${base}/dsh-kit/skills?cwd=${encodeURIComponent(tmp)}`).then((r) => r.json());
  const groupOf = (body, id) => body.groups.find((g) => g.id === id);
  const find = (body, groupId, name) => groupOf(body, groupId)?.skills.find((s) => s.name === name);
  const op = (payload) =>
    fetch(`${base}/dsh-kit/skills/op`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmp, ...payload }),
    });

  // 1) 结构：三逻辑组 + 组内 roots 子结构 + 字段齐全
  let body = await listSkills();
  check("结构：三逻辑组 workspace/user/pool", JSON.stringify(body.groups.map((g) => g.id)) === '["workspace","user","pool"]');
  check("结构：workspace 组含两个物理根", groupOf(body, "workspace").roots.length === 2);
  check(
    "结构：物理根带 rank（.dsh=100、.agents=200、pool=null）",
    (() => {
      const w = groupOf(body, "workspace").roots;
      const p = groupOf(body, "pool").roots[0];
      return w.find((r) => r.id === "project-dsh")?.rank === 100 &&
        w.find((r) => r.id === "project-agents")?.rank === 200 &&
        p?.rank === null;
    })(),
  );
  check("结构：user 组含两个物理根", groupOf(body, "user").roots.length === 2);
  check("结构：pool 组含一个物理根", groupOf(body, "pool").roots.length === 1);

  // 2) 枚举与归属字段
  const hello = find(body, "workspace", "hello-kit");
  check("枚举：hello-kit 在 workspace 组", !!hello);
  check("枚举：root/rank 字段正确", hello?.root === "project-agents" && hello?.rank === 200);
  const dupHigh = find(body, "workspace", "dup-kit") && body.groups.flatMap((g) => g.skills).find((s) => s.name === "dup-kit" && s.root === "project-dsh");
  check(
    "shadowed：rank 小者胜、大者被覆盖",
    (() => {
      const all = body.groups.flatMap((g) => g.skills).filter((s) => s.name === "dup-kit");
      const high = all.find((s) => s.root === "project-dsh");
      const low = all.find((s) => s.root === "project-agents");
      return high?.shadowed === false && low?.shadowed === true && high?.rank === 100 && low?.rank === 200;
    })(),
    JSON.stringify(body.groups.flatMap((g) => g.skills).filter((s) => s.name === "dup-kit")),
  );
  void dupHigh;
  check("枚举：providers 为数组", Array.isArray(body.providers));

  // 3) 复制到池（dest=物理根 id）
  let res = await op({ op: "copy", src: hello.path, dest: "pool" });
  check("复制到池：200", res.status === 200);
  body = await listSkills();
  check("复制到池：池里出现同名技能且 root=pool", (() => {
    const p = find(body, "pool", "hello-kit");
    return !!p && p.root === "pool" && p.rank === null && p.shadowed === false;
  })());
  check("复制到池：源仍在工作区", !!find(body, "workspace", "hello-kit"));

  // 4) 冲突与覆盖
  res = await op({ op: "copy", src: hello.path, dest: "pool" });
  check("重复复制：409 conflict", res.status === 409);
  res = await op({ op: "copy", src: hello.path, dest: "pool", overwrite: true });
  check("覆盖复制：200", res.status === 200);

  // 5) 移动平铺技能到池（源消失）——补一个平铺 fixture
  const flatFile = path.join(tmp, ".dsh", "skills", "flat-kit.md");
  fs.writeFileSync(flatFile, "---\nname: flat-kit\ndescription: 平铺测试技能\n---\nbody\n");
  res = await op({ op: "move", src: flatFile, dest: "pool" });
  check("移动到池：200", res.status === 200);
  body = await listSkills();
  check("移动后：工作区不再有 flat-kit", !find(body, "workspace", "flat-kit"));
  check("移动后：池里有 flat-kit 且内容完好", (() => {
    const s = find(body, "pool", "flat-kit");
    return !!s && fs.readFileSync(s.file, "utf8").includes("description: 平铺测试技能");
  })());

  // 6) 禁用 / 启用（frontmatter 双键热生效）
  const poolHello = find(await listSkills(), "pool", "hello-kit");
  res = await op({ op: "disable", src: poolHello.path, disabled: true });
  const disJson = await res.json();
  check("禁用：200 且返回 disabled=true", res.status === 200 && disJson.disabled === true);
  let text = fs.readFileSync(poolHello.file, "utf8");
  check(
    "禁用：frontmatter 写入双键",
    /^disable-model-invocation:[ \t]*true$/m.test(text) && /^user-invocable:[ \t]*false$/m.test(text),
  );
  check("禁用：用户其余内容保留", text.includes("description: 目录型测试技能") && text.includes("# hello-kit"));
  body = await listSkills();
  check("禁用：再次枚举标记 disabled", find(body, "pool", "hello-kit")?.disabled === true);
  res = await op({ op: "disable", src: poolHello.path, disabled: false });
  check("启用：200 且返回 disabled=false", res.status === 200 && (await res.json()).disabled === false);
  text = fs.readFileSync(poolHello.file, "utf8");
  check("启用：双键已移除", !/^disable-model-invocation:/m.test(text) && !/^user-invocable:/m.test(text));

  // 7) 删除 = 真删（文件系统直接消失，无 .trash 中转）
  const flatInPool = find(await listSkills(), "pool", "flat-kit");
  res = await op({ op: "delete", src: flatInPool.path });
  check("删除：200", res.status === 200);
  check("删除：磁盘上已不存在", !fs.existsSync(flatInPool.path));
  check("删除：列表不再出现", !find(await listSkills(), "pool", "flat-kit"));

  // 8) 安全：白名单外的路径拒绝
  res = await op({ op: "copy", src: fileURLToPath(new URL("../package.json", import.meta.url)), dest: "pool" });
  check("白名单外源：400", res.status === 400);

  // 9) 同根移动/复制拒绝
  res = await op({ op: "move", src: path.join(tmp, ".agents", "skills", "hello-kit"), dest: "project-agents" });
  check("同根操作：400", res.status === 400);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nALL SKILL-POOL TESTS PASS" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
