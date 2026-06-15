import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.overkill.signals',
  appName: 'Overkill',
  webDir: 'dist',
  plugins: {
    // Background evaluation: WorkManager periodic task. 15 min is the Android
    // minimum. Best-effort on aggressive-battery OEMs (see README / Samsung note).
    BackgroundRunner: {
      label: 'io.overkill.signals.evaluate',
      src: 'runner.js',
      event: 'evaluate',
      repeat: true,
      interval: 15,
      autoStart: true,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_overkill',
      iconColor: '#C6F432',
    },
  },
};

export default config;
