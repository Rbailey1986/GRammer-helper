# Grammar Helper

An offline grammar, spelling and writing assistant. Everything runs on your computer, so nothing you type is uploaded.

It uses two engines:

- **[Harper](https://writewithharper.com)**: instant rule-based checking that underlines mistakes as you type.
- **[CoEdIT](https://huggingface.co/grammarly/coedit-large)** (by Grammarly): an AI model that rewrites a whole sentence.
  It can fix grammar, make the sentence simpler, clearer or more formal, or paraphrase it. It runs inside the desktop app.

| Part | What it does |
|---|---|
| **Chrome extension** (`extension/`) | Underlines mistakes as you type in any text box in Chrome. Hover an underlined word for suggestions, select text to get a rewrite toolbar, or click the badge in the corner of the text box for a panel with your writing score and every suggestion. |
| **Desktop app** (`app/`) | A window you can type or paste text into, with a sentence-rewrite panel. It also has a global hotkey that checks text you've selected in any app. The Chrome extension uses the app for rewrites. |

Underline colours: **red** = spelling · **blue** = grammar · **purple** = style

## Rewriting sentences

- **Desktop app:** click inside a sentence (or select some text), then choose **Fix / Simpler / Clearer / Formal / Paraphrase**
  in the panel on the right. Changes are highlighted. Click **Accept** to apply them.
- **Chrome:** click an underlined word and use the **Rewrite sentence** row in the card, or press `Alt+Shift+R` in any
  text box. **The desktop app must be running**, because the model lives there.
- Click **Edit** to adjust a rewrite before accepting it.
- Each rewrite takes about half a second (up to about a second for **Fix**). The first one after starting the app takes a few seconds longer while the model loads.
- **Fix** and **Clearer** try several instructions and keep the best candidate. A **meaning check** throws out candidates
  that bring in new words (a sign the model changed what you meant), and Harper then picks the one with the fewest
  remaining mistakes. If every candidate fails the check, the card shows a warning.
- The model can still occasionally change the meaning of a sentence, so always read a rewrite before you accept it.

## Saving corrections for training

Every rewrite you **accept**, **edit then accept**, or **dismiss** is saved to a file on your computer (never uploaded):

- Windows: `%APPDATA%\Grammar Helper\training\corrections.jsonl`
- Mac: `~/Library/Application Support/Grammar Helper/training/corrections.jsonl`

Edited rewrites are the most valuable: they record exactly what the model got wrong and what you wanted.
The tray menu shows how many have been saved, opens the folder, and has a switch to turn saving off.
Once a few hundred have built up, they can be used to fine-tune the model to your style.

Spelling uses **British English** (colour, realise, theatre).

## Hotkeys

| Where | Keys | Action |
|---|---|---|
| Chrome | `Alt+Shift+G` | Jump to the next mistake in the current text box |
| Chrome | `Alt+Shift+F` | Fix every mistake in the current text box |
| Chrome | `Alt+Shift+R` | Rewrite the current sentence (or the selected text) |
| Anywhere (desktop app running) | `Ctrl+Alt+G` (Windows) / `⌘⌥G` (Mac) | Copy the selected text into Grammar Helper and check it. Press **Replace in app** to paste the fixed text back. |

To change the Chrome shortcuts, go to `chrome://extensions/shortcuts`.

---

## Windows setup

**Desktop app:** run `app\dist\Grammar Helper Setup 1.0.0.exe` (about 700 MB, because it includes the AI model).
Windows SmartScreen may warn that the app is unsigned; click **More info → Run anyway**. After installing, the app
sits in the system tray. Right-click the tray icon and choose **Start when I log in** to have it start automatically.

**Chrome extension:**
1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the `extension` folder
4. If you're updating an older copy, click the reload icon on its card instead

## MacBook (Intel) setup

1. Install Node.js LTS from https://nodejs.org
2. Copy this whole `grammer helper` folder to the Mac, **including `app/models`** (the ~785 MB AI model).
   You can leave out `app/node_modules` and `app/dist`.
3. In Terminal:
   ```sh
   cd "grammer helper/app"
   npm install
   cd .. && node build.mjs && cd app
   npm run dist:mac
   ```
4. Open `app/dist/Grammar Helper-1.0.0.dmg` and drag the app into Applications.
5. The first time you open it, **right-click the app → Open** (it's unsigned, so macOS asks once).
6. For the `⌘⌥G` hotkey, allow Grammar Helper in **System Settings → Privacy & Security → Accessibility**.
   The app asks for this the first time you press the hotkey.
7. Install the Chrome extension the same way as on Windows.

You can also run the app without building it: `cd app && npm start`.

## The fine-tuned model

The rewrite model in `app/models/coedit-large` has been fine-tuned on this PC's GPU to fix the original model's
weak spots (*have went*, double negatives, *me and him was*, their/there, *less/fewer*, *them tracks*, *she's sang*, …) with small edits that keep your
meaning and slang. On test sentences it never saw during training:

| | Original CoEdIT | Fine-tuned |
|---|---|---|
| Hard hand-written sentences fixed exactly | 45% | 98% |
| Planted mistakes fixed | 49% | 95% |
| Correct sentences left unchanged | 54% | 97% |

To retrain later (e.g. with your saved corrections), see `tools/training/README.md`.

## Making changes

- `shared/checker.js` holds the checking logic and the rewrite instructions shared by both parts. After editing it,
  run `node build.mjs` to copy it into both.
- After changing the extension, click the reload icon on its card in `chrome://extensions`.
- Rebuild the Windows installer: `cd app && npm run dist:win`
- To rebuild the model from Grammarly's original files (needs Python with `torch`, `optimum-onnx[onnxruntime]`,
  `transformers` and `sentencepiece`):
  `python tools/convert_coedit.py <work-folder> app/models/coedit-large`

## How the parts connect

- The desktop app runs CoEdIT in a hidden window using WebAssembly, so the same code works on Windows and Intel Macs.
- The Chrome extension asks the app for rewrites at `http://127.0.0.1:47321`. That address only exists on your own
  computer, and the app refuses requests from websites; only the extension is allowed.

## Limits

- **Google Docs** draws its text on a canvas instead of in normal text boxes, so the extension can't underline there.
  Use the hotkey with the desktop app instead.
- CoEdIT works best one or two sentences at a time.
- The CoEdIT model is licensed for **non-commercial use only** (CC BY-NC 4.0). Fine for personal use, but you can't sell it.
- English only.
