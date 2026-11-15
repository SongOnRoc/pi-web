// The card in a real browser: where it sits, what it looks like, and whether a
// click (mouse or touch) answers the question. Screenshots land in `shots/`.
//
//   node e2e/ask-question-browser.mjs [base]

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const BASE = process.argv[2] ?? process.env.PI_WEB_BASE ?? "http://127.0.0.1:31004";
const OUT = fileURLToPath(new URL("./shots/", import.meta.url));
const EXECUTABLE = process.env.PI_WEB_CHROMIUM
  ?? "C:/Users/dell/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe";

const PROMPT = "Call the ask_user_question tool exactly once: one question, id \"env\", question \"Deploy to which environment?\", header \"Choose environment\", options \"Staging (Recommended)\" with description \"Validate on production-like config first.\" and \"Production\" with description \"Go straight to real users.\". Then stop.";

const shots = [];
async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  shots.push(name);
}

/** Wait until the card is on screen, and return its box. */
async function waitForCard(page) {
  const card = page.locator('[role="dialog"][aria-label]').filter({ has: page.locator('input[placeholder]') });
  await card.first().waitFor({ state: "visible", timeout: 240_000 });
  return card.first();
}

/**
 * Start a fresh chat, so the card comes from this run: the desktop pass leaves a
 * settled call behind in its session.
 */
async function askAndWait(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const newChat = page.getByRole("button", { name: /新建|New chat|New session/i }).first();
  if (await newChat.count()) {
    await newChat.click().catch(() => {});
  }
  const composer = page.locator("textarea").first();
  await composer.waitFor({ timeout: 120_000 });
  await composer.fill(PROMPT);
  // A phone's Enter is a newline, not a send: press the button the composer offers.
  const send = page.locator('.chat-input-shell button[aria-label]').filter({ hasText: /^$/ })
    .and(page.locator('button[aria-label="' + (await sendLabel(page)) + '"]'));
  if (await send.count()) {
    await send.first().click();
  } else {
    await page.keyboard.press("Enter");
  }
  return waitForCard(page);
}

/** The composer's Send button, in whichever language the UI is showing. */
async function sendLabel(page) {
  return page.evaluate(() => {
    const button = [...document.querySelectorAll(".chat-input-shell button")]
      .find((candidate) => /send|发送|傳送|送出/i.test(candidate.getAttribute("aria-label") ?? ""));
    return button?.getAttribute("aria-label") ?? "Send";
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXECUTABLE });

  try {
    // --- desktop -----------------------------------------------------------
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await desktop.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator("textarea").first().waitFor({ timeout: 120_000 });
    const card = await askAndWait(page);
    await shot(page, "desktop-card");

    // Where it sits: directly above the composer, and as wide as it.
    const geometry = await page.evaluate(() => {
      const card = document.querySelector('[role="dialog"]');
      // The width constraint lives in the composer's inner column, not the padded
      // fieldset around it, so that is what the card is measured against.
      const composer = document.querySelector(".chat-input-shell")?.querySelector("div");
      const cardBox = card?.getBoundingClientRect();
      const composerBox = composer?.getBoundingClientRect();
      return {
        cardBottom: cardBox?.bottom,
        composerTop: composerBox?.top,
        cardWidth: cardBox?.width,
        composerWidth: composerBox?.width,
        cardLeft: cardBox?.left,
        composerLeft: composerBox?.left,
      };
    });
    console.log("geometry", geometry);
    if (geometry.cardWidth && geometry.composerWidth) {
      const delta = Math.abs(geometry.cardWidth - geometry.composerWidth);
      if (delta > 2) throw new Error(`card is ${delta}px off the composer's width`);
    }
    if (geometry.cardBottom && geometry.composerTop && geometry.cardBottom > geometry.composerTop + 2) {
      throw new Error("the card overlaps the composer instead of sitting above it");
    }

    // A click on an option selects it.
    const radio = card.locator('[role="radio"]').filter({ hasText: "Production" });
    await radio.first().click();
    const checked = await radio.first().getAttribute("aria-checked");
    if (checked !== "true") throw new Error("clicking an option did not select it");
    await shot(page, "desktop-selected");

    // Submit answers the call.
    await card.getByRole("button", { name: /提交|Submit/ }).click();
    await card.waitFor({ state: "detached", timeout: 60_000 });
    await shot(page, "desktop-answered");
    console.log("desktop: clicked, submitted, card closed");

    await desktop.close();

    // --- phone -------------------------------------------------------------
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    const mobile = await phone.newPage();
    await mobile.goto(BASE, { waitUntil: "domcontentloaded" });
    await mobile.locator("textarea").first().waitFor({ timeout: 120_000 });
    let phoneCard;
    try {
      phoneCard = await askAndWait(mobile);
    } catch (error) {
      await shot(mobile, "mobile-failure");
      throw error;
    }
    await shot(mobile, "mobile-card");

    // No horizontal overflow: the card must fit the viewport.
    const fit = await mobile.evaluate(() => {
      const card = document.querySelector('[role="dialog"]');
      const scroller = card?.querySelector("div");
      return {
        viewport: window.innerWidth,
        cardRight: card?.getBoundingClientRect().right,
        cardLeft: card?.getBoundingClientRect().left,
        scrollWidth: scroller?.scrollWidth,
        clientWidth: scroller?.clientWidth,
      };
    });
    console.log("mobile fit", fit);
    if (fit.cardRight && fit.cardRight > fit.viewport + 1) throw new Error("the card overflows the viewport on a phone");

    // A tap answers too.
    const phoneRadio = phoneCard.locator('[role="radio"]').filter({ hasText: "Staging" });
    await phoneRadio.first().tap();
    if ((await phoneRadio.first().getAttribute("aria-checked")) !== "true") {
      throw new Error("tapping an option did not select it on a phone");
    }
    await shot(mobile, "mobile-selected");
    await phoneCard.getByRole("button", { name: /提交|Submit/ }).tap();
    await phoneCard.waitFor({ state: "detached", timeout: 60_000 });
    await shot(mobile, "mobile-answered");
    console.log("mobile: tapped, submitted, card closed");

    await phone.close();
    console.log("screenshots:", shots.join(", "));
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
