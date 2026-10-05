// Full Mac control for the brain (docs/autonomy-prompt.md, section 0): files, windows, the browser, the screen,
// UI automation, system switches, the clipboard, Shortcuts, and sending things to the phone. Each tool is a thin
// call over the bridge to control.js in the ARES app, which holds the folder scope, the tiers and the audit log.
// Registered into the ares MCP server by tools/mac.js.
const { z } = require('zod');

function register({ tool, bridge }) {
  const ctl = (name, args = {}) => bridge(`/control/${name}`, args);

  // ---- Files -------------------------------------------------------------------------------------------------------
  tool('find_files',
    'Find files on the Mac with Spotlight, in the user\'s folders (Desktop, Documents, Downloads, iCloud Drive and any they added): by name or '
    + 'words inside, kind, and date. "What did I download yesterday?" → folder "Downloads", since "yesterday". Returns paths to use with read_file, '
    + 'open_item, manage_files or send_to_phone.',
    {
      query: z.string().optional().describe('Words in the name or the contents'),
      kind: z.enum(['any', 'image', 'pdf', 'document', 'spreadsheet', 'presentation', 'video', 'audio', 'folder', 'archive', 'code']).optional(),
      since: z.string().optional().describe('"today", "yesterday", "this week", "3 days", or a date'),
      until: z.string().optional(),
      folder: z.string().optional().describe('Limit to one folder, e.g. "Downloads" or "~/Documents/Tax"'),
      limit: z.number().int().optional(),
    },
    async (a) => (await ctl('files/find', a)).message);

  tool('read_file',
    'Read a file so you can answer questions about it or summarise it: text and code, PDFs (scans are OCR\'d), Word/RTF documents, and pictures '
    + '(you get the picture and any text in it). Big files come in pieces: use offset. Also lists a folder. Only inside the user\'s folders; '
    + 'spreadsheets and slide decks go to a background job instead.',
    { path: z.string().describe('A path, "~/Downloads/x.pdf", or just a file name to look up in the user\'s folders'), offset: z.number().int().optional(), max_chars: z.number().int().optional() },
    async (a) => ctl('files/read', a));

  tool('open_item',
    'Open a file or folder on the Mac (in its usual app, or a named app), or reveal it in Finder.',
    { path: z.string(), reveal: z.boolean().optional().describe('Show it in Finder instead of opening it'), app: z.string().optional().describe('Open with this app, e.g. "Preview"') },
    async (a) => (await ctl('files/open', a)).message);

  tool('manage_files',
    'Create a folder, or move, rename, copy or trash a file or folder. Inside the user\'s folders this just happens (and is logged); anywhere else, '
    + 'and the Trash always, needs their yes first: the result tells you to ask, so describe exactly what will happen and do it once they say yes. '
    + 'Nothing is ever deleted permanently, only moved to the Trash. Never overwrites.',
    {
      action: z.enum(['create_folder', 'move', 'rename', 'copy', 'trash']),
      path: z.string().describe('The file or folder (for create_folder: the new folder\'s path)'),
      to: z.string().optional().describe('Destination folder or path, for move/copy'),
      name: z.string().optional().describe('The new name, for rename'),
    },
    async (a) => (await ctl('files/manage', a)).message);

  // ---- Apps and windows ------------------------------------------------------------------------------------------------
  tool('list_windows', 'Every open window on the Mac, by app, with sizes and positions, and which app is in front. Says if the screen is locked.', {},
    async () => (await ctl('windows/list', {})).message);

  tool('focus_app', 'Bring an app to the front (opens it if needed).', { name: z.string() }, async (a) => (await ctl('apps/focus', a)).message);

  tool('arrange_window',
    'Move and resize a window: "put Safari on the left and Notes on the right" is two calls with place "left" and "right". Places: left, right, top, '
    + 'bottom, top-left, top-right, bottom-left, bottom-right, full, centre, left-third, middle-third, right-third, left-two-thirds, right-two-thirds; '
    + 'or an exact frame (x, y, w, h in pixels, or fractions of the screen).',
    { app: z.string(), window: z.string().optional().describe('Words from the window\'s title, when the app has several'), place: z.string().optional(), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(), screen: z.number().int().optional() },
    async (a) => (await ctl('windows/arrange', a)).message);

  tool('window_action', 'Minimise, un-minimise, zoom, full-screen, exit full screen, close or raise a window.',
    { app: z.string(), window: z.string().optional(), action: z.enum(['minimise', 'unminimise', 'zoom', 'fullscreen', 'exit-fullscreen', 'close', 'raise']) },
    async (a) => (await ctl('windows/action', a)).message);

  tool('switch_space', 'Switch Mission Control Spaces (desktops): next, previous, or a number.', { to: z.string() }, async (a) => (await ctl('spaces/switch', a)).message);

  // ---- Browser -----------------------------------------------------------------------------------------------------------
  tool('browser_tab',
    'The user\'s browser (Safari, Chrome, Edge, Brave or Arc; the front one unless named): the current tab\'s URL and title ("current"), every open tab '
    + '("list"), or the current page\'s text ("text") for "summarise this page" / "what does this page say?".',
    { what: z.enum(['current', 'list', 'text']).optional(), browser: z.enum(['safari', 'chrome', 'edge', 'brave', 'arc']).optional() },
    async (a) => (await ctl('browser/tab', a)).message);

  tool('browser_open', 'Open a web page in a particular browser (open_url uses the default browser).',
    { url: z.string(), browser: z.enum(['safari', 'chrome', 'edge', 'brave', 'arc']).optional(), new_window: z.boolean().optional() },
    async (a) => (await ctl('browser/open', a)).message);

  // ---- Screen ------------------------------------------------------------------------------------------------------------
  tool('look_at_screen',
    'Take a screenshot of the window in front (or a named app\'s window, or the whole screen) and look at it: "what\'s on my screen?", "what does this '
    + 'error say?", "what\'s that window?". ONLY when the user explicitly asks to see or read their screen, never on your own. ocr: true adds the exact '
    + 'text. to_phone: true also sends the picture to their phone ("show me my screen" from the phone). If the screen is locked or asleep you\'re told; '
    + 'say so plainly and offer the alternatives.',
    { app: z.string().optional(), window: z.string().optional(), whole_screen: z.boolean().optional(), ocr: z.boolean().optional(), to_phone: z.boolean().optional() },
    async (a) => ctl('screen/look', a));

  // ---- UI automation --------------------------------------------------------------------------------------------------------
  tool('ui_elements',
    'See what\'s in an app\'s front window as a list of elements (buttons, fields, links, menus, text) with ids and positions, for apps with no other way '
    + 'in. Read it, then act with ui_act, then read again: windows change. Default: the app in front.',
    { app: z.string().optional(), max: z.number().int().optional() },
    async (a) => (await ctl('ui/elements', a)).message);

  tool('ui_act',
    'Do one thing in an app\'s window, like a person would, with a visible highlight so the user sees it: press/click an element (by id from ui_elements), '
    + 'type into it, set a field\'s value, double/right click, scroll, press a key ("return", "cmd+s", "esc") or choose a menu item ("File>Save As…"). '
    + 'One step per call; re-read the window between steps. Anything that SENDS, SUBMITS, BUYS, POSTS or DELETES is held for the user\'s yes '
    + '(pass irreversible: true yourself when you know a step will, and describe it to them first). The user can stop you any time with Esc or "stop".',
    {
      app: z.string().optional(),
      element: z.string().optional().describe('An element id from ui_elements'),
      action: z.enum(['click', 'press', 'double_click', 'right_click', 'type', 'set_value', 'focus', 'scroll', 'key', 'menu']),
      text: z.string().optional().describe('What to type / set; for scroll, pixels (negative = up)'),
      key: z.string().optional().describe('For action key: "return", "tab", "esc", "cmd+s", "ctrl+right"…'),
      menu: z.string().optional().describe('For action menu: titles separated by >, e.g. "Edit>Select All"'),
      x: z.number().optional().describe('Screen coordinates instead of an element'),
      y: z.number().optional(),
      irreversible: z.boolean().optional().describe('true when this step sends, submits, pays, posts or deletes'),
    },
    async (a) => (await ctl('ui/act', a)).message);

  // ---- System ------------------------------------------------------------------------------------------------------------------
  tool('system_control',
    'Mac system switches: Focus/Do Not Disturb (focus_on, focus_off), Wi-Fi (wifi_on, wifi_off), Bluetooth (bluetooth_on, bluetooth_off), brightness '
    + '(level 0-100, or "up"/"down"), dark mode (dark_mode_on, dark_mode_off, dark_mode_toggle), display_sleep (locks the Mac), eject (name of the drive).',
    { action: z.enum(['focus_on', 'focus_off', 'wifi_on', 'wifi_off', 'bluetooth_on', 'bluetooth_off', 'brightness', 'dark_mode_on', 'dark_mode_off', 'dark_mode_toggle', 'display_sleep', 'eject']), level: z.union([z.number(), z.string()]).optional(), name: z.string().optional() },
    async (a) => (await ctl('system/control', a)).message);

  tool('system_info', 'Battery, storage, network (Wi-Fi, IP, Tailscale) and general Mac info. what: "all", or some of battery, storage, network, general.',
    { what: z.string().optional() }, async (a) => (await ctl('system/info', a)).message);

  tool('audio_output', 'Which device sound plays through; name one to switch ("AirPods", "MacBook Pro Speakers").', { device: z.string().optional() },
    async (a) => (await ctl('audio/output', a)).message);

  // ---- Clipboard, Shortcuts ---------------------------------------------------------------------------------------------------------
  tool('clipboard', 'Read the Mac\'s clipboard ("what did I just copy?") or put text on it ("copy that").',
    { action: z.enum(['read', 'write']), text: z.string().optional() }, async (a) => (await ctl('clipboard', a)).message);

  tool('list_shortcuts', 'The user\'s Apple Shortcuts, by name.', {}, async () => (await ctl('shortcuts/list', {})).message);
  tool('run_shortcut', 'Run one of the user\'s Apple Shortcuts by name, optionally with text input; returns what it produced.',
    { name: z.string(), input: z.string().optional() }, async (a) => (await ctl('shortcuts/run', a)).message);

  // ---- To the phone ----------------------------------------------------------------------------------------------------------------
  tool('send_to_phone',
    'Send something from the Mac to the user\'s phone, through the ARES app (a notification with Open; files download privately, never a public link): '
    + 'a file ("send this PDF to my phone"), a screenshot of the front window ("send me the screenshot"), the clipboard, a link ("put the current page on my '
    + 'phone": get it with browser_tab first), or text. Job results have their own tool (send_job_to_phone).',
    { kind: z.enum(['file', 'screenshot', 'clipboard', 'link', 'text']), path: z.string().optional(), url: z.string().optional(), text: z.string().optional(), title: z.string().optional() },
    async (a) => (await ctl('phone/send', a)).message);

  // ---- Permissions, the log ------------------------------------------------------------------------------------------------------------
  tool('check_permissions', 'Which macOS permissions ARES has (Accessibility, Screen Recording) and how the others work. ARES never asks for Full Disk Access.', {},
    async () => (await ctl('permissions/check', {})).message);
  tool('request_permission',
    'Make macOS show a permission prompt for ARES. Before calling, explain to the user in one sentence what the permission is for and that the prompt '
    + 'is about to appear; only when they\'re at the Mac.',
    { which: z.enum(['accessibility', 'screen_recording']) }, async (a) => (await ctl('permissions/request', a)).message);

  tool('recent_actions', 'The log of what ARES has done on the Mac recently (tier, what, how it was approved): "what did you do while I was out?".',
    { limit: z.number().int().optional() }, async (a) => (await ctl('audit/recent', a)).message);

  tool('allowed_folders', 'Which folders ARES may read and organise files in, and how to add one.', {}, async () => (await ctl('files/scope', {})).message);
}

module.exports = { register };
