// Work mode's tool registry: everything a background worker (jobs.js) can use, in one place. Chat mode never
// loads any of this. Each entry says whether it's available (usually: is its key in the support .env?), which
// built-in tools or MCP server it adds, which of its tools pass the gate without asking, and what the worker
// is told about it. To add a tool later (Notion, Exa…): one entry here plus its key in the .env.
const fs = require('fs');
const path = require('path');
const { isPublicUrl } = require('./egress');

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} o.env
 * @param {string} o.appDir     where ARES's code lives (tools/work.js, node_modules)
 * @param {string} o.runtime    <userData>/work/.runtime (python venv, node libs, skills plugin)
 * @param {object} o.bridge     { url, token }
 * @param {() => string} o.egress  the worker browsers' proxy URL (egress.js)
 */
function registry({ env, appDir, runtime, bridge, egress }) {
  const playwrightCli = (() => {
    const cli = path.join(appDir, '..', 'node_modules', '@playwright', 'mcp', 'cli.js'); // not in the package's exports map
    return fs.existsSync(cli) ? cli : null;
  })();
  const plugin = path.join(runtime, 'plugin');
  const node = (script, args, extra) => ({ command: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1', ...extra } });

  return [
    {
      id: 'web',
      available: true,
      builtin: ['WebSearch', 'WebFetch'],
      allow: ['WebSearch'], // WebFetch goes through the gate, which keeps it off localhost and private networks
      prompt: '- WebSearch to find sources. WebFetch answers a question about one page (it summarises, so details can get lost).',
      gate: { WebFetch: async (input) => ((await isPublicUrl(input.url)) ? 'allow' : 'Only public http(s) web pages.') },
    },
    {
      id: 'files',
      available: true,
      builtin: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      allow: [],
      prompt: '- Read, Write, Edit, Glob, Grep for files in your working folder (and reading your skills\' own files).',
    },
    {
      id: 'work', // ARES's own worker MCP server: the gate plus small tools
      available: true,
      builtin: [],
      allow: ['mcp__work'],
      mcp: (job, dir) => node(path.join(appDir, 'tools', 'work.js'), [], {
        ARES_BRIDGE: bridge.url, ARES_TOKEN: bridge.token, ARES_JOB: job.id, ARES_JOB_DIR: dir,
        ...(env.UNSPLASH_ACCESS_KEY ? { UNSPLASH_ACCESS_KEY: env.UNSPLASH_ACCESS_KEY } : {}),
        ...(env.FIRECRAWL_API_KEY ? { FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY } : {}),
      }),
      prompt: [
        `- mcp__work__read_page(url): the clean full text of a web page as markdown (${env.FIRECRAWL_API_KEY ? 'Firecrawl, falling back to Jina Reader' : 'Jina Reader'}). Use it to actually read articles, docs and reports; it's quicker and cheaper than a browser.`,
        env.UNSPLASH_ACCESS_KEY
          ? '- mcp__work__search_images(query) and mcp__work__download_image(id): free stock photos from Unsplash. download_image saves the photo into images/ and returns the markdown to embed plus the credit line. Always keep that credit line ("Photo by … on Unsplash", with its links) right under the image, in result.md and in any document or slide that uses it.'
          : '- No stock-photo tool is set up (Unsplash needs a key), so use screenshots, charts and diagrams instead.',
      ].join('\n'),
    },
    {
      id: 'playwright', // Microsoft's Playwright MCP: a real (headless, throwaway) browser
      available: Boolean(playwrightCli),
      builtin: [],
      allow: [],
      mcp: (job, dir) => node(playwrightCli, [
        '--headless', '--isolated', '--block-service-workers',
        '--output-dir', path.join(dir, 'screens'),
        '--viewport-size', '1280,800',
        '--proxy-server', egress(), '--proxy-bypass', '<-loopback>', // everything through egress.js, even localhost
      ], {}),
      prompt: '- mcp__playwright__browser_*: a real browser, for pages that need JavaScript, clicking through, or when you want a screenshot. browser_take_screenshot with a filename like "screens/pricing.png" saves it in your folder. Never log in, buy, submit forms or post anything.',
      gate: {
        browser_navigate: async (input) => ((await isPublicUrl(input.url)) ? 'allow' : 'Only public http(s) web pages.'),
        browser_file_upload: () => 'ask',
        browser_install: () => 'No browser installs.',
        '*': (input) => {
          // Anything that names an output file must land inside the job folder (checked by the caller)
          if (input && typeof input.filename === 'string') return { file: input.filename };
          return 'allow';
        },
      },
    },
    {
      id: 'bash',
      available: fs.existsSync(path.join(runtime, 'venv', 'bin', 'python3')),
      builtin: ['Bash'],
      allow: [],
      prompt: '- Bash, sandboxed: it runs inside your working folder with no network and no access to the user\'s files. python3 (with openpyxl, pandas, python-docx, python-pptx, pypdf, pdfplumber, reportlab, matplotlib, markitdown), node (with docx and pptxgenjs), soffice (LibreOffice, headless) and pdftoppm are installed. Write scripts to files in your folder and run them (python3 make_deck.py, node build.js), and edit them with Edit. Inline code (python3 -c, heredocs), deleting files and unusual commands wait for the user\'s OK, so keep commands plain.',
    },
    {
      id: 'skills', // Document skills (docx, pdf, pptx, xlsx) as a worker-only plugin; dataviz is built into Claude Code
      available: fs.existsSync(path.join(plugin, 'skills')),
      builtin: ['Skill'],
      allow: ['Skill'],
      pluginDir: plugin,
      prompt: '- Skill: load ares-worker:docx, ares-worker:pptx, ares-worker:xlsx or ares-worker:pdf BEFORE making that kind of file, and dataviz before designing a chart. Their scripts live in the skill\'s own folder; run them with python3 from your working folder.',
    },
    // ---- Later: uncomment-free, they switch on when their key is in the support .env ----
    {
      id: 'notion',
      available: Boolean(env.NOTION_TOKEN),
      builtin: [],
      allow: [],
      mcp: () => ({ command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: env.NOTION_TOKEN } }),
      prompt: '- mcp__notion__*: the user\'s Notion. Reading is fine; changes wait for the user\'s OK.',
    },
    {
      id: 'exa',
      available: Boolean(env.EXA_API_KEY),
      builtin: [],
      allow: ['mcp__exa'],
      mcp: () => ({ type: 'http', url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': env.EXA_API_KEY } }),
      prompt: '- mcp__exa__*: Exa neural web search, good for finding specific pages, companies and papers.',
    },
  ].filter((t) => t.available);
}

module.exports = { registry };
