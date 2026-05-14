const envAppId =
  import.meta.env.VITE_VIVERSE_CLIENT_ID ||
  import.meta.env.VITE_VIVERSE_APP_ID ||
  "";

export const VIVERSE_CONFIG = {
  APP_ID: envAppId,
  AUTH_DOMAIN: "account.htcvive.com",
  AVATAR_BASE_URL: "https://sdk-api.viverse.com/",
  VERSION_NAME: "1.0.0-template-baseline"
};
