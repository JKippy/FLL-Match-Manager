// Browser for the Playwright tests.
// Unset PWBROWSER (or chromium) launches Chromium with the caller's options,
// the same Google Chrome path the Chrome CI job already uses.
// PWBROWSER=firefox or webkit launches that Playwright browser.
// Pass browserName to override the env (the WebKit click test defaults to webkit).
const { chromium, firefox, webkit } = require('playwright-core');

const INSTALL = {
  firefox: 'npx --prefix test playwright-core install --with-deps firefox',
  webkit: 'npx --prefix test playwright-core install --with-deps webkit',
};

async function launchBrowser(chromiumOpts, browserName) {
  const name = (browserName || process.env.PWBROWSER || 'chromium').toLowerCase();
  try {
    if (name === 'firefox') {
      // Same idea as Chromium's --autoplay-policy=no-user-gesture-required:
      // display tests start WebAudio without a gesture.
      return await firefox.launch({
        firefoxUserPrefs: {
          'media.autoplay.default': 0,
          'media.autoplay.enabled.user-gestures-needed': false,
          'media.autoplay.block-webaudio': false,
          'media.autoplay.blocking_policy': 0,
        },
      });
    }
    if (name === 'webkit') return await webkit.launch();
    if (name !== 'chromium') throw new Error('PWBROWSER must be chromium, firefox, or webkit');
    return await chromium.launch(chromiumOpts);
  } catch (e) {
    if (INSTALL[name] && /Executable doesn't exist|browserType\.launch/i.test(e.message))
      e.message += '\nInstall ' + name + ': ' + INSTALL[name];
    throw e;
  }
}

module.exports = { launchBrowser };
