// index.native.tsx
import { AppRegistry } from 'react-native';
import BackgroundGeolocation from 'react-native-background-geolocation';
import App from './App';
import { name as appName } from './app.json';
import 'react-native-get-random-values';
import 'react-native-gesture-handler';

/**
 * Headless task — runs when the app has been terminated (Android) so that
 * location events keep being processed without the main React tree.
 *
 * The native SDK uploads every recorded fix directly over HTTP on its own, so
 * uploads survive JS teardown. This task only handles the events that need a
 * decision: re-arming tracking after the location provider is re-enabled,
 * surfacing failed uploads, and flushing the persistence queue.
 *
 * Keep this minimal and side-effect free: no storage, no network calls beyond
 * the SDK's own APIs, and never let an exception escape (a crash here kills
 * the background JS context until the next app launch).
 */
BackgroundGeolocation.registerHeadlessTask(async (event) => {
    const { name, params } = event;
    console.log('[BackgroundGeolocation headless]', name);

    try {
        switch (name) {
            case 'location':
            case 'motionchange':
                // The native HTTP transport already posted/filters this fix.
                break;

            case 'providerchange':
                // Location services were toggled: when they come back on,
                // make sure tracking actually resumes if it was enabled before.
                if (params && params.enabled) {
                    const state = await BackgroundGeolocation.getState();
                    if (state.enabled && !state.isMoving) {
                        await BackgroundGeolocation.changePace(true);
                    }
                }
                break;

            case 'http':
                if (params && params.status >= 400) {
                    console.warn('[BackgroundGeolocation headless] HTTP upload failed:', params.status, params.responseText);
                }
                break;

            case 'heartbeat':
                // Flush any persisted-but-unuploaded fixes.
                await BackgroundGeolocation.sync();
                break;

            case 'boot':
                // Device rebooted (startOnBoot). The SDK restores its own
                // persisted state; nothing app-specific to do here.
                break;

            default:
                break;
        }
    } catch (error) {
        console.error('[BackgroundGeolocation headless] Error handling', name, error);
    }
});

AppRegistry.registerComponent(appName, () => App);
