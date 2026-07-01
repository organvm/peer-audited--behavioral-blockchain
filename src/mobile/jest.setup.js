// Jest setup for the mobile (React Native) workspace.
//
// Intentionally minimal: specs mock their own native dependencies locally, and
// service specs (e.g. NotificationService) deliberately exercise the code path
// where optional Expo native modules are unavailable. Adding global mocks here
// would mask those branches, so this file only exists as an extension point.
