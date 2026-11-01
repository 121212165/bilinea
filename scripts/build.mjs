import { build } from 'esbuild';
import { rmSync, cpSync, mkdirSync } from 'node:fs';

const prod = process.env.NODE_ENV === 'production';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = {
  bundle: true,
  minify: prod,
  sourcemap: false,
  target: ['chrome120'],
  platform: 'browser',
  logLevel: 'info',
  legalComments: 'none',
};

await build({ ...common, entryPoints: ['src/content/index.ts'], outfile: 'dist/content/index.js', format: 'iife' });
await build({
  ...common,
  entryPoints: ['src/service/index.ts'],
  outfile: 'dist/service/index.js',
  format: 'esm',
});
await build({
  ...common,
  entryPoints: ['src/pages/options/index.ts'],
  outfile: 'dist/options/index.js',
  format: 'iife',
});
await build({
  ...common,
  entryPoints: ['src/pages/popup/index.ts'],
  outfile: 'dist/popup/index.js',
  format: 'iife',
});
// PDF 页用 ESM：运行时 dynamic import 扩展内的 pdf/pdf.min.mjs（不打包进 bundle）
await build({
  ...common,
  entryPoints: ['src/pages/pdf/index.ts'],
  outfile: 'dist/pdf/index.js',
  format: 'esm',
});

cpSync('static', 'dist', { recursive: true });
// 页面 html + css（MV3 禁止内联脚本，html 必须引用编译后的 index.js）
cpSync('src/pages/options/index.html', 'dist/options/index.html');
cpSync('src/pages/options/style.css', 'dist/options/style.css');
cpSync('src/pages/popup/index.html', 'dist/popup/index.html');
cpSync('src/pages/popup/style.css', 'dist/popup/style.css');
cpSync('src/pages/pdf/index.html', 'dist/pdf/index.html');
cpSync('src/pages/pdf/style.css', 'dist/pdf/style.css');

// T-028 PDF: local pdf.js runtime assets (no remote code). The PDF page imports
// pdf/pdf.min.mjs dynamically and points GlobalWorkerOptions at pdf/pdf.worker.min.mjs.
// CMaps + standard fonts are needed for CJK / non-embedded fonts; wasm is not shipped yet.
mkdirSync('dist/pdf', { recursive: true });
cpSync('node_modules/pdfjs-dist/build/pdf.min.mjs', 'dist/pdf/pdf.min.mjs');
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf/pdf.worker.min.mjs');
cpSync('node_modules/pdfjs-dist/cmaps', 'dist/pdf/cmaps', { recursive: true });
cpSync('node_modules/pdfjs-dist/standard_fonts', 'dist/pdf/standard_fonts', { recursive: true });
cpSync('node_modules/pdfjs-dist/LICENSE', 'dist/pdf/LICENSE.txt');

console.log('[itr] build done → dist/');
