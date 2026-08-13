import { Linking, Platform } from 'react-native';

/**
 * Open the system screen that lets the driver exempt this app from battery
 * optimization. OEM battery managers (Xiaomi, Samsung, Oppo, Vivo, Huawei)
 * aggressively kill background services for apps that are "optimized", which
 * stops driver location updates until the app is reopened.
 *
 * No-ops on iOS (its background-mode model does not have this setting).
 */
export async function openBatteryOptimizationSettings(): Promise<void> {
    if (Platform.OS !== 'android') return;

    try {
        // System battery-optimization list for all apps — no special grant needed
        // to open this screen and lets the driver flip this app to "Don't optimize".
        await Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    } catch (error) {
        console.warn('[BatteryOptimization] Cannot open battery optimization settings, falling back to app settings:', error);
        try {
            await Linking.openSettings();
        } catch (fallbackError) {
            console.warn('[BatteryOptimization] Cannot open app settings:', fallbackError);
        }
    }
}
