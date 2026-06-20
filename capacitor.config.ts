import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for Overkill Signals.
 *
 * ALERT-ONLY APP. There are no exchange credentials and no execution endpoints
 * anywhere in this project. The app evaluates daily-close 200-EMA crossovers and
 * notifies a human; the human decides and acts.
 */
const config: CapacitorConfig = {
  appId: 'com.overkill.signals',
  appName: 'Overkill Signals',
  webDir: 'dist',
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_signal',
      iconColor: '#10b981'
    },
    // Background Runner drives best-effort periodic evaluation while the app is
    // backgrounded. Android caps periodic WorkManager tasks at 15 min minimum.
    BackgroundRunner: {
      label: 'com.overkill.signals.check',
      src: 'runners/runner.js',
      event: 'evaluateSignals',
      repeat: true,
      interval: 15,
      autoStart: true
    }
  }
};

export default config;
