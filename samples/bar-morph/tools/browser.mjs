import puppeteer from "puppeteer-core";

// The still is the live page at 1510x822 CSS px, extended to 16:9; rendered at 2x and downscaled to 1280x720.
export const VIEW = { width: 1510, height: 849, deviceScaleFactor: 2 };
export const VARIANTS = { a: "a-liquid", b: "b-split", c: "c-reflow" };

export async function open(origin, page, query = "rec=1") {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/local/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"],
  });
  const tab = await browser.newPage();
  await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await tab.setViewport(VIEW);
  await tab.goto(`${origin}/${page}.html?${query}`, { waitUntil: "networkidle0" });
  await tab.waitForFunction("window.__ready === true");
  const inter = await tab.evaluate(() => document.fonts.check('16px "Inter var"'));
  if (!inter) throw new Error("Inter var did not load (rsms.me unreachable?)");
  return { browser, tab };
}
