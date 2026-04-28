import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ecoscan.app',
  appName: 'EcoScan',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
