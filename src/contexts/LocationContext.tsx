import React, { createContext, useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import BackgroundGeolocation from 'react-native-background-geolocation';
import BackgroundFetch from 'react-native-background-fetch';
import { Place, Point } from '@fleetbase/sdk';
import { config } from '../utils';
import { useAuth } from './AuthContext';
import useStorage from '../hooks/use-storage';
import useFleetbase from '../hooks/use-fleetbase';

const LocationContext = createContext({
    location: null,
    isTracking: false,
    startTracking: () => {},
    stopTracking: () => {},
});

// Location is reported on a TIME-BASED cadence (default: every 5 minutes while
// the device is moving). No GPS runs while the driver is stationary.
const LOCATION_UPDATE_INTERVAL_MS = 1000 * 60 * 5;

export const LocationProvider = ({ children }) => {
    const { isOnline, driver, trackDriver } = useAuth();
    const { adapter } = useFleetbase();
    const [authToken] = useStorage('_driver_token');
    const [location, setLocation] = useStorage(`${driver?.id ?? 'anon'}_location`, {});
    const [isTracking, setIsTracking] = useState(false);

    // Whether tracking SHOULD be active (used by event handlers that must not
    // capture stale state, and by the one-time ready() effect).
    const shouldTrackRef = useRef(false);
    useEffect(() => {
        shouldTrackRef.current = !!(driver && isOnline);
    }, [driver, isOnline]);

    // Whether BackgroundGeolocation.ready() has resolved. State (not a ref) so
    // the setConfig effect re-runs when the SDK finishes initializing.
    const [geoReady, setGeoReady] = useState(false);

    // The SDK listeners are registered exactly once, but the MMKV storage key
    // changes when the driver record loads — always write through a ref so the
    // handler never targets a stale key.
    const setLocationRef = useRef(setLocation);
    useEffect(() => {
        setLocationRef.current = setLocation;
    }, [setLocation]);

    // Manually track location (single fix + immediate upload).
    const trackLocation = useCallback(async () => {
        try {
            const location = await BackgroundGeolocation.getCurrentPosition({
                samples: 1,
                desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_NAVIGATION,
                extras: {
                    event: 'getCurrentPosition',
                },
            });
            setLocation(location);
            trackDriver(location.coords);
        } catch (error) {
            console.warn('Error attempting to track and update location:', error);
        }
    }, [trackDriver]);

    // Get the drivers location as a Place
    const getDriverLocationAsPlace = useCallback(
        (attributes = {}) => {
            const { coords } = location;

            return new Place(
                {
                    id: 'driver',
                    name: 'Driver Location',
                    street1: 'Driver Location',
                    location: new Point(coords.latitude, coords.longitude),
                    ...attributes,
                },
                adapter
            );
        },
        [location, adapter]
    );

    // Get the HTTP configuration for background geolocation tracking.
    // Returns {} until host/driver/token are all available. The native SDK
    // uploads each recorded fix directly to this endpoint — even when the JS
    // runtime is dead — as long as this config has been applied via ready()
    // or setConfig().
    const getHttpConfig = useCallback(() => {
        if (!adapter || !driver || !authToken) return {};

        return {
            url: `${adapter.host}/${adapter.namespace}/drivers/${driver.id}/track`,
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json',
                'User-Agent': '@fleetbase/navigator-app',
            },
            httpRootProperty: '.',
            locationTemplate:
                '{"latitude":<%= latitude %>,"longitude":<%= longitude %>,"heading":<%= heading %>,"speed":<%= speed %>,"altitude":<%= altitude %>,"timestamp":"<%= timestamp %>","activity":"<%= activity.type %>","is_moving":<%= is_moving %>,"battery":{"level":<%= battery.level %>,"is_charging":<%= battery.is_charging %>}}',
        };
    }, [adapter, driver, authToken]);

    // --- Event handlers -----------------------------------------------------

    const onLocation = useCallback((location) => {
        console.log('[BackgroundGeolocation] onLocation:', location);
        setLocationRef.current(location);

        // Keep isTracking in sync with reality — the SDK reports its
        // enabled state through getState(), isTracking is best-effort.
        setIsTracking(true);
    }, []);

    const onMotionChange = useCallback(
        (event) => {
            console.log('[BackgroundGeolocation] onMotionChange:', event);
            if (event.location) {
                onLocation(event.location);
            }
        },
        [onLocation]
    );

    const onLocationError = useCallback((error) => {
        console.warn('[BackgroundGeolocation] onLocationError:', error);
    }, []);

    // Re-arm tracking when the provider (GPS/location services) is re-enabled.
    const onProviderChange = useCallback((event) => {
        console.log('[BackgroundGeolocation] onProviderChange:', event);
        if (event.enabled && shouldTrackRef.current) {
            BackgroundGeolocation.getState().then((state) => {
                if (!state.enabled) {
                    console.log('[BackgroundGeolocation] Provider re-enabled — restarting tracking');
                    BackgroundGeolocation.start();
                }
            });
        }
    }, []);

    // Surface failed uploads (401 = expired token, 4xx/5xx = server rejects payload).
    const onHttp = useCallback((response) => {
        if (response.status >= 400) {
            console.warn('[BackgroundGeolocation] HTTP upload failed:', response.status, response.responseText);
        }
    }, []);

    // Stationary-state liveness pulse — flush any persisted-but-unuploaded fixes.
    const onHeartbeat = useCallback(() => {
        console.log('[BackgroundGeolocation] onHeartbeat — syncing pending locations');
        BackgroundGeolocation.sync().catch((error) => console.warn('[BackgroundGeolocation] sync failed:', error));
    }, []);

    // Function to start tracking.
    const startTracking = useCallback(() => {
        BackgroundGeolocation.start(() => {
            setIsTracking(true);
            console.log('[BackgroundGeolocation] Tracking started');
        });
    }, []);

    // Function to stop tracking.
    const stopTracking = useCallback(() => {
        BackgroundGeolocation.stop(() => {
            setIsTracking(false);
            console.log('[BackgroundGeolocation] Tracking stopped');
        });
    }, []);

    // --- Effects ------------------------------------------------------------

    // One-time SDK initialization. ready() MUST be called exactly once (library
    // contract) and listeners must be registered exactly once — re-running this
    // effect caused duplicate listeners and dropped/misapplied HTTP config.
    useEffect(() => {
        BackgroundGeolocation.onLocation(onLocation, onLocationError);
        BackgroundGeolocation.onMotionChange(onMotionChange);
        BackgroundGeolocation.onProviderChange(onProviderChange);
        BackgroundGeolocation.onHttp(onHttp);
        BackgroundGeolocation.onHeartbeat(onHeartbeat);

        BackgroundGeolocation.ready(
            {
                backgroundPermissionRationale: {
                    title: `Allow ${config('APP_NAME')} to access your location`,
                    message: `${config('APP_NAME')} collects location data to update your position while you are online, even when the app is closed or running in the background. This allows dispatchers and ops teams to track your progress and provide better support while you drive.`,
                    positiveAction: 'Allow',
                    negativeAction: 'Deny',
                },
                // Time-based tracking: one fix every LOCATION_UPDATE_INTERVAL_MS
                // while moving. distanceFilter 0 disables distance-triggered
                // recording so the interval (not meters traveled) is what
                // schedules fixes — no GPS duty while stationary.
                desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_NAVIGATION,
                distanceFilter: 0,
                locationUpdateInterval: LOCATION_UPDATE_INTERVAL_MS,
                fastestLocationUpdateInterval: LOCATION_UPDATE_INTERVAL_MS,
                // iOS-only: let the OS batch/defer delivery up to 5 min so the
                // GPS radio can sleep between fixes.
                deferTime: LOCATION_UPDATE_INTERVAL_MS,
                stopOnTerminate: false,
                startOnBoot: true,
                // Stay in tracking mode through short stops (traffic lights).
                stopTimeout: 5,
                heartbeatInterval: 300,
                // Persist failed uploads for up to 3 days; sync() retries them.
                maxDaysToPersist: 3,
                // Per-fix upload (server endpoint expects a single object, not
                // the array payload batchSync would send).
                batchSync: false,
                autoSync: true,
                debug: false,
                ...getHttpConfig(),
            },
            (state) => {
                setGeoReady(true);
                console.log('[BackgroundGeolocation] is ready:', state);
                if (shouldTrackRef.current) {
                    startTracking();
                }
            }
        );

        return () => {
            BackgroundGeolocation.removeListeners();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Apply the HTTP upload config once auth/host/driver are available (and if
    // any of them change later). This is the critical fix for "location only
    // updates when the app is open": ready() may run before the session is
    // restored from storage, which previously left the native upload URL unset.
    useEffect(() => {
        if (!geoReady) return;
        if (!adapter || !driver || !authToken) return;

        BackgroundGeolocation.setConfig(getHttpConfig())
            .then(() => console.log('[BackgroundGeolocation] HTTP config applied for driver:', driver.id))
            .catch((error) => console.warn('[BackgroundGeolocation] setConfig failed:', error));
    }, [geoReady, adapter, driver, authToken, getHttpConfig]);

    // BackgroundFetch is only a liveness net: flush the persistence queue. The
    // native transport already uploads every fix, so calling trackLocation()
    // here (the old behavior) caused a redundant double-upload every 5 minutes
    // plus an extra GPS acquisition.
    useEffect(() => {
        BackgroundFetch.configure(
            {
                minimumFetchInterval: 15,
                stopOnTerminate: false,
                startOnBoot: true,
            },
            async (taskId) => {
                try {
                    const count = await BackgroundGeolocation.getCount();
                    if (count > 0) {
                        console.log('[BackgroundFetch] Flushing', count, 'pending locations');
                        await BackgroundGeolocation.sync();
                    }
                } catch (error) {
                    console.warn('[BackgroundFetch] sync failed:', error);
                }
                BackgroundFetch.finish(taskId);
            },
            (error) => {
                console.warn('[BackgroundFetch] failed to configure:', error);
            }
        );
    }, []);

    // Toggle tracking based on the driver's online status.
    useEffect(() => {
        if (!driver) return;
        if (isOnline) {
            startTracking();
        } else {
            stopTracking();
        }
    }, [driver, isOnline, startTracking, stopTracking]);

    // Reconcile tracker state when the app returns to the foreground. If an OEM
    // battery manager killed the SDK's foreground service while the process
    // survived, this re-arms tracking for online drivers — and stops it if the
    // driver went offline from another device.
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState !== 'active' || !driver) return;

            BackgroundGeolocation.getState()
                .then((state) => {
                    if (isOnline && !state.enabled) {
                        console.log('[AppState] Foregrounded — re-arming tracking for online driver');
                        startTracking();
                    } else if (!isOnline && state.enabled) {
                        console.log('[AppState] Foregrounded — stopping tracking for offline driver');
                        stopTracking();
                    }
                })
                .catch((error) => console.warn('[AppState] getState failed:', error));
        });

        return () => subscription.remove();
    }, [driver, isOnline, startTracking, stopTracking]);

    // Memoize the context value to prevent unnecessary re-renders.
    const value = useMemo(
        () => ({ location, isTracking, startTracking, stopTracking, getDriverLocationAsPlace, trackLocation }),
        [location, isTracking, startTracking, stopTracking, getDriverLocationAsPlace, trackLocation]
    );

    return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
};

// Custom hook to use the LocationContext.
export const useLocation = () => {
    const context = useContext(LocationContext);
    if (context === undefined) {
        throw new Error('useLocation must be used within a LocationProvider');
    }
    return context;
};
