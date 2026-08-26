// CodeMirror 6 vendor 构建脚本（一次性工程动作，产物提交入库）。
// 产出 client/vendor/codemirror.bundle.js：IIFE 单文件，暴露 window.CM6 工厂。
// 运行时零构建；仅升级 CM 时重跑本脚本：node scripts/build-vendor.mjs
//
// 依赖临时安装到系统临时目录，不进项目 package.json（保持插件零 dependencies 声明）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = process.cwd()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm6-vendor-'))
const PKGS = [
  'esbuild@0.24.2',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@lezer/highlight',
  'codemirror',
  '@codemirror/lang-javascript',
  '@codemirror/lang-python',
  '@codemirror/lang-css',
  '@codemirror/lang-html',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/lang-xml',
  '@codemirror/lang-sql',
  '@codemirror/legacy-modes',
]

const ENTRY = `
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { HighlightStyle, syntaxHighlighting, StreamLanguage } from "@codemirror/language";
import { tags as tg } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { go } from "@codemirror/legacy-modes/mode/go";
import { rust } from "@codemirror/legacy-modes/mode/rust";

const kitHighlight = HighlightStyle.define([
  { tag: tg.keyword, color: "var(--dshk-tok-keyword)" },
  { tag: [tg.string, tg.special(tg.string)], color: "var(--dshk-tok-string)" },
  { tag: [tg.comment, tg.quote], color: "var(--dshk-tok-comment)", fontStyle: "italic" },
  { tag: [tg.number, tg.bool, tg.null], color: "var(--dshk-tok-number)" },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: "var(--dshk-tok-fn)" },
  { tag: [tg.typeName, tg.className, tg.namespace], color: "var(--dshk-tok-type)" },
  { tag: [tg.operator], color: "var(--dshk-tok-operator)" },
  { tag: [tg.meta, tg.processingInstruction], color: "var(--dshk-tok-meta)" },
  { tag: tg.link, color: "var(--dshk-tok-link)", textDecoration: "underline" },
  { tag: tg.heading, color: "var(--dshk-tok-heading)", fontWeight: "600" },
  { tag: tg.invalid, color: "#f85149" },
]);

const js = () => javascript();
const jsx = () => javascript({ jsx: true });
const ts = () => javascript({ typescript: true });
const tsx = () => javascript({ typescript: true, jsx: true });

const EXT_LANGS = {
  js, mjs: js, cjs: js, jsx,
  ts, tsx,
  py: () => python(), pyw: () => python(),
  css: () => css(),
  html: () => html(), htm: () => html(),
  json: () => json(),
  md: () => markdown(), markdown: () => markdown(),
  xml: () => xml(), svg: () => xml(),
  sql: () => sql(),
  yml: () => StreamLanguage.define(yaml), yaml: () => StreamLanguage.define(yaml),
  toml: () => StreamLanguage.define(toml),
  sh: () => StreamLanguage.define(shell), bash: () => StreamLanguage.define(shell), zsh: () => StreamLanguage.define(shell),
  lua: () => StreamLanguage.define(lua),
  ruby: () => StreamLanguage.define(ruby), rb: () => StreamLanguage.define(ruby),
  go: () => StreamLanguage.define(go),
  rs: () => StreamLanguage.define(rust),
};

function resolveLang(ext) {
  const factory = EXT_LANGS[String(ext || "").toLowerCase()];
  if (!factory) return [];
  try { return [factory()]; } catch { return []; }
}

/** 创建编辑器实例。返回句柄供宿主薄层调用。 */
function create(container, opts) {
  const o = opts || {};
  const langComp = new Compartment();
  const roComp = new Compartment();
  let onChangeCb = null;
  const view = new EditorView({
    state: EditorState.create({
      doc: String(o.doc ?? ""),
      extensions: [
        basicSetup,
        syntaxHighlighting(kitHighlight),
        langComp.of(resolveLang(o.language)),
        roComp.of(o.readOnly ? EditorView.editable.of(false) : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && typeof onChangeCb === "function") onChangeCb(view.state.doc.toString());
        }),
      ],
    }),
    parent: container,
  });
  view.dom.classList.add("dshk-cm", "dshk-cm-scope");
  return {
    view,
    setEditable(next) { view.dispatch({ effects: roComp.reconfigure(next ? [] : EditorView.editable.of(false)) }); },
    getDoc() { return view.state.doc.toString(); },
    setDoc(text) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text) } }); },
    onDocChanged(fn) { onChangeCb = fn; },
    destroy() { view.destroy(); },
  };
}

window.CM6 = { create };
`

try {
  console.log('临时环境:', tmp)
  fs.writeFileSync(path.join(tmp, 'package.json'), '{}')
  fs.writeFileSync(path.join(tmp, 'entry-cm6.mjs'), ENTRY)
  console.log('npm install 中…')
  execSync(`npm install --no-audit --no-fund --loglevel=error ${PKGS.join(' ')}`, { cwd: tmp, stdio: 'inherit' })
  console.log('esbuild 打包中…')
  const esbuild = createRequire(path.join(tmp, 'node_modules', 'esbuild', 'package.json'))('esbuild')
  await esbuild.build({
    entryPoints: [path.join(tmp, 'entry-cm6.mjs')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    outfile: path.join(root, 'client', 'vendor', 'codemirror.bundle.js'),
    legalComments: 'inline',
  })
  const size = fs.statSync(path.join(root, 'client', 'vendor', 'codemirror.bundle.js')).size
  console.log(`完成: codemirror.bundle.js ${(size / 1024).toFixed(0)} KB`)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* esbuild 句柄释放有延迟，残留临时目录无害 */ }
}
