import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.kurkurkury.calendar",
  appName: "Kalender",
  webDir: "www",
  server: {
    androidScheme: "calendar-mvp"
  }
};

export default config;
