# 🕵️ DataDome Network Capture with Playwright

This project is a **Playwright-based CLI tool** that lets you capture and analyze how websites protected by [DataDome](https://datadome.co) respond to your requests.  
It produces a clear narrative of:

- What happens on the **initial request** (authorized `200` or blocked `403`)
- If **blocked**, which **challenge steps** are triggered (Device Check and/or CAPTCHA/BLOCK)
- Whether a **DataDome cookie** is set on any response
- Your **external request IP** and **User-Agent**
- A full **HAR file** and **cookie jar** for each session

---

## 📦 Features

- Interactive CLI with numeric menus:
  - Browser: Chromium / Firefox / WebKit
  - Headless mode: Yes / No
  - User-Agent: default or custom string
- Auto-finish on **network idle** (no manual input required)
- **Network Requests section**:
  - Shows only Document / XHR / Fetch requests
  - Always displays DataDome `Set-Cookie` values for main and challenge requests
- **Artifacts saved** for each session:
  - `HAR` file (all captured requests & responses)
  - `Cookies` JSON file (final cookie jar)
- Robust `Set-Cookie` parsing
- External **Request IP** captured via Chromium (using CDP)

---

## 🚀 Installation

Clone this repo and install dependencies:

```bash
git clone https://github.com/your-repo/datadome-playwright-capture.git
cd datadome-playwright-capture
npm install
npx playwright install