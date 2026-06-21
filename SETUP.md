# ChurnLence — Setup Guide

Two devices, two install paths. Pick one.

---

## 🖥  On your **Windows PC**

You have **three** install paths, pick whichever fits.

### Option 1 — One-click `.exe` (no Python, no setup) ✨ recommended

1. Open the **GitHub repository** in your browser.
2. Click the **Actions** tab.
3. Click the latest successful "Build Windows installer" workflow run.
4. Scroll to the bottom and download the artifact named
   **`ChurnLence-Windows`** — inside is a single `ChurnLence.exe`
   (~60 MB, all dependencies bundled).
5. Move `ChurnLence.exe` anywhere you like (Desktop, `C:\Tools\`, etc.).
6. **Double-click it.** A console window appears, the server starts, and
   your default browser opens to http://localhost:5000 automatically.
7. Close the console window when you're done.

> **Tip:** Pin `ChurnLence.exe` to your taskbar — one click to start.
>
> Your portfolio data is saved to `%LOCALAPPDATA%\ChurnLence\portfolio.db`
> so it survives even if you move or replace the .exe.
>
> **Windows SmartScreen warning?** The exe isn't code-signed (signing
> certificates cost ~$200/yr). Click *More info → Run anyway* the first
> time — Windows remembers the choice.

### Option 2 — Auto-install (`install-and-run.bat`)

If you can't access GitHub Actions or want to run from source:

1. Download or clone this folder.
2. Double-click **`install-and-run.bat`**.
3. If Python isn't installed, the script downloads the official Python
   installer, runs it silently for your user only (no admin), and then
   keeps going. Total: ~90 sec on first run.
4. After that the app launches in ~2 sec and opens the browser.

### Option 3 — Already have Python

1. Double-click **`run-windows.bat`** — it just creates a venv, installs
   deps, starts the app.

---

**Demo mode** (no internet / synthetic prices, just to click around):
double-click **`run-windows-demo.bat`** instead of any of the above.

**First time? Do this:**
   - On the Holdings tab, click *⤓ Import CSV* and paste or upload a CSV
     from your broker, **or** click a preset chip (Magnificent 7 / Core
     index / Crypto top 5 / Semis) to add a starter basket with one click.

### Troubleshooting Windows

| Symptom | Fix |
|---|---|
| Double-clicking the `.bat` flashes and closes | Right-click → *Edit* to open in Notepad first; it shouldn't happen unless an earlier error aborted it. Also try running `run-windows.ps1` with PowerShell. |
| "Python was not found" | Reinstall Python and tick *Add python.exe to PATH*. Restart. |
| "Failed to install packages" | Check you're online. Corporate firewalls may block pip — try from a home network. |
| Port 5000 already in use | Another program is using it. Close it, or edit `app.py` and change `PORT=5000` to `PORT=5050`. |

---

## 📱  On your **Samsung Galaxy S24 Ultra** (and any Android)

ChurnLence installs as a **Progressive Web App (PWA)** — a web app that
behaves exactly like a native Android app. Icon on the home screen.
Fullscreen. Offline-ready shell.

**You need a URL your phone can reach.** Two options:

### Option A — Same Wi-Fi as your PC (no cloud needed)

1. Start ChurnLence on your PC (see above).
2. Find your PC's local IP address:
   - Press <kbd>Win</kbd>+<kbd>R</kbd>, type `cmd`, press Enter.
   - Type `ipconfig` and press Enter.
   - Look for *IPv4 Address* under your Wi-Fi adapter — e.g. `192.168.1.42`.
3. First time only: in Windows, allow Python through the firewall:
   - *Settings → Privacy & security → Windows Security → Firewall &
     network protection → Allow an app → Change settings → Allow another
     app → Browse → `...\ChurnLence\.venv\Scripts\python.exe`* and tick
     both **Private** and **Public**. (Usually a prompt appears the first
     time you run it — just click *Allow access*.)
4. On your Galaxy, open **Chrome** and go to `http://192.168.1.42:5000`
   (use *your* PC's IP). You'll see ChurnLence.
5. Install it to the home screen: **Chrome menu (⋮) → *Install app***
   (or *Add to Home screen*). The app icon now appears on your home
   screen. Tap it to launch fullscreen — it won't look like a browser.

### Option B — Deploy to a cloud URL (works anywhere, free)

Once deployed, the app is reachable from any phone on any network, and
signal-transition **emails run 24/7** even when your PC is off.

**Fly.io** (~5 minutes, free tier):

```bash
# On your PC, in the ChurnLence folder:
fly launch --copy-config --no-deploy        # creates the app
fly volumes create churnlence_data --size 1 --region iad
fly deploy                                   # ~2 min build + push
fly open                                     # prints the URL
```

**Render** (~3 minutes, free tier, GUI):

1. Push this folder to a GitHub repo.
2. Go to https://render.com → *New → Blueprint* → point at your repo.
3. Render detects `render.yaml` and builds automatically. You get a
   `https://churnlence-xxxx.onrender.com` URL.

Then, on your Galaxy, open that URL in Chrome and hit *Install app*.

---

## 📧  Email alerts (optional)

If you deployed to Fly or Render, set these env vars to get emails when
a holding's signal flips:

```bash
fly secrets set \
  SMTP_HOST=smtp.sendgrid.net \
  SMTP_PORT=587 \
  SMTP_USER=apikey \
  SMTP_PASS=<your-sendgrid-api-key> \
  SMTP_FROM=you@example.com
fly deploy --strategy immediate
```

Then in the app: **⋯ → Email alerts…**, enter your email, tick the
checkbox, Save. The server checks signals every 5 minutes.

> **SendGrid** (free) or **Mailgun** (free trial) both give you SMTP
> credentials in a few clicks. Gmail also works if you create an
> *App Password* — use `smtp.gmail.com`, port `587`, your Gmail as user,
> the app password as pass.

---

## 🔐  About the data

- All positions and transactions are stored in a local SQLite file
  (`portfolio.db` on Windows, `/data/portfolio.db` on Fly/Render).
- Nothing is sent to me or any external service except your broker /
  yfinance for quotes.
- Back it up by copying the `portfolio.db` file.
