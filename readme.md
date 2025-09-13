# dd-playwright-open-any-website

> Playwright-based network capture tool with **DataDome focus**.  
> Captures **Document/XHR/Fetch** requests (no static assets), extracts **DataDome cookies**, **x-datadome-clientid** headers, challenge flows (**Device Check / CAPTCHA / Block**), and saves full HAR + cookies for analysis.

---

## ✨ Features

- **Multi-browser engine support**
  - Chromium, Firefox, WebKit (select at launch).
- **Custom or predefined User-Agents**
  - Enter your own UA string.
  - Use built-in **DD UA Test Codes**:
    - `BLOCKUA` → CAPTCHA
    - `BLOCKUAHARDBLOCKUA` → CAPTCHA > Block
    - `HARDBLOCK` → Block
    - `HARDBLOCK_UA` → Block (cross-origin XHR only)
    - `DeviceCheckTestUA` → Device Check
    - `DeviceCheckTestUA-BLOCKUA` → Device Check > CAPTCHA
    - `DeviceCheckTestUA-HARDBLOCK` → Device Check > Block
- **Initial request & redirects**
  - Shows full **DataDome Set-Cookie** value if present.
- **Network capture (Document/XHR/Fetch only)**
  - Excludes static assets (CSS/JS/fonts/images/etc.).
  - Logs:
    - Request method, URL, status (colored).
    - **DataDome Set-Cookie** values (response).
    - **datadome cookie** value (request).
    - **x-datadome-clientid** header (request).
    - Payloads (query params for GET, parsed body for POST).
- **Sequential event tracking**
  - On `403 DOCUMENT`, logs the **next request** inline (Device Check / CAPTCHA / Block) with details.
  - Prevents duplication of that next request.
- **HAR + cookies export**
  - Full `.har` with embedded content.
  - Cookies JSON for session replay.

---

## 🚀 Usage

### 1. Install

```bash
git clone https://github.com/inkkonito/dd-playwright-open-any-website-debug.git
cd dd-playwright-open-any-website-debug
npm install