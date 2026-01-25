import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.calendar.mvp",
  appName: "Calendar MVP",
  webDir: "www",
  server: {
    androidScheme: "calendar-mvp"
  }
};

export default config;
