'use strict';

const settingsPages = Object.freeze({
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
});

function createMacPermissionSetup({ dialog, systemPreferences, desktopCapturer, shell, getHostStatus }) {
  return async function showMacPermissionSetup(parent) {
    const status = await getHostStatus();
    const platform = status.platform || {};
    const screen = platform.canCapture === true;
    const input = platform.canInput === true;
    const options = {
      type: 'info', title: 'Set up Orbit on your Mac',
      message: 'Allow screen sharing and remote control',
      detail: `Screen Recording: ${screen ? 'Allowed' : 'Approval needed'}\nAccessibility: ${input ? 'Allowed' : 'Approval needed'}\n\n` +
        'Approve Orbit Remote in System Settings to share this Mac. Screen Recording lets paired computers see your displays. Accessibility lets a paired computer use your mouse and keyboard when you grant control.\n\n' +
        'macOS may request approval for the Orbit host or its launch application. Quit and reopen Orbit after changing permissions. Pairing and remote-control grants remain separate.',
      buttons: ['Request Screen Recording', 'Request Accessibility', 'Screen Recording Settings', 'Accessibility Settings', 'Done'],
      defaultId: 4, cancelId: 4, noLink: true,
    };
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    switch (response) {
      case 0:
        // Enumeration prompts through macOS; zero thumbnails avoid collecting
        // desktop images just to request permission. Nothing is persisted.
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') await shell.openExternal(settingsPages.screen);
        break;
      case 1:
        if (!systemPreferences.isTrustedAccessibilityClient(true)) await shell.openExternal(settingsPages.accessibility);
        break;
      case 2: await shell.openExternal(settingsPages.screen); break;
      case 3: await shell.openExternal(settingsPages.accessibility); break;
    }
  };
}

module.exports = { createMacPermissionSetup };
