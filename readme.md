# 🕵️‍♂️ dd-playwright-open-any-website

A **Playwright-based debugging tool** to open any website or API endpoint and **capture/analyze network traffic** with a focus on **anti-bot detection systems (like DataDome)**. The tool gives you full visibility into **sequential request flows**, **cookies**, and **headers**, so you can clearly see where challenges such as **Device Check** or **CAPTCHA/Block** are triggered.

---

## ✨ Features
- **Interactive setup (prompt-based)**
  - Choose what to test:
    - `GET document/API`
    - `POST request with payload`
  - Select browser engine: `Chromium`, `Firefox`, `WebKit`
  - Run in `Headless` or `Headful` mode
  - Select User-Agent:
    - Default
    - Custom
    - Predefined **DD UA Test Codes**:
      - `BLOCKUA = CAPTCHA`
      - `BLOCKUAHARDBLOCKUA = CAPTCHA > Block`
      - `HARDBLOCK = Block`
      - `HARDBLOCK_UA = Block [Only on cross-origin XHR]`
      - `DeviceCheckTestUA = Device Check`
      - `DeviceCheckTestUA-BLOCKUA = Device Check > CAPTCHA`
      - `DeviceCheckTestUA-HARDBLOCK = Device Check > Block`
  - Select **network logging scope**:
    - Same-domain only
    - Cross-origin only
    - Any origin
  - Finish mode:
    - Auto (network idle + 5s)
    - Manual (press Enter)
  - Enter URL (validated until correct, e.g. `leboncoin.fr` → `https://leboncoin.fr`)

---

## 📖 What Gets Logged
### Run Recap
- Timestamp
- URL
- What to test
- Browser
- Headless (Yes/No)
- User-Agent
- Egress IP (your outgoing IP detected live)
- Network logging scope
- Session folder
- HAR file path
- Cookies file path
- Finish mode

### Full Network Capture
- **Only** logs requests of type: `Document`, `XHR`, `Fetch`
- **Excludes static assets** (CSS, JS, fonts, images, videos, etc.)
- **Always includes challenge domains** (`geo.captcha-delivery.com`):
  - `/interstitial` → Device Check
  - `/captcha` → CAPTCHA/Block
- Each request displays:
  - Method, URL, status code
  - Classification (Document, XHR, Fetch, Device Check, CAPTCHA/Block)
  - **Query params** (for GET requests)
  - **Payload/body** (for POST/PUT/PATCH requests)
  - **Request headers**:
    - `x-datadome-clientid` if present
  - **Request cookies**:
    - Full `datadome` cookie if present
  - **Response headers**:
    - Full `datadome` Set-Cookie if present (with domain/path/flags)

### Saved Artifacts
- HAR file (all network traffic)
- Cookies JSON file (all browser cookies)

---

## 🖥️ Example Output