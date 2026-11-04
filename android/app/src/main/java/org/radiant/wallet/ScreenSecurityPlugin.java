package org.radiant.wallet;

import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Window-level screenshot / screen-recording protection.
 *
 * Sets WindowManager.LayoutParams.FLAG_SECURE on the app window, which makes the
 * OS:
 *   • refuse screenshots (screenshot attempts fail outright),
 *   • exclude the window from MediaProjection screen recordings / casting,
 *   • blank the app in the Recents thumbnail.
 *
 * The JS side raises the flag only while a recovery phrase is on screen (see
 * src/lib/screenSecurity.ts), so ordinary screens like Receive remain
 * screenshot-able.
 *
 * Caveat worth knowing: FLAG_SECURE is enforced by the Android framework. It
 * cannot stop a rooted device, a malicious app with elevated privileges, or
 * someone simply photographing the phone with another camera.
 */
@CapacitorPlugin(name = "ScreenSecurity")
public class ScreenSecurityPlugin extends Plugin {

    @PluginMethod
    public void setSecure(PluginCall call) {
        Boolean enabledBoxed = call.getBoolean("enabled", Boolean.FALSE);
        final boolean enabled = Boolean.TRUE.equals(enabledBoxed);

        if (getActivity() == null) {
            call.reject("No foreground activity");
            return;
        }
        final android.app.Activity activity = getActivity();

        // Window flags must be touched on the UI thread.
        activity.runOnUiThread(() -> {
            try {
                if (enabled) {
                    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                } else {
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                }
                JSObject ret = new JSObject();
                ret.put("secure", enabled);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Could not change window flags: " + e.getMessage());
            }
        });
    }

    /** Report the current state so JS can sanity-check after a resume. */
    @PluginMethod
    public void isSecure(PluginCall call) {
        boolean secure = false;
        if (getActivity() != null) {
            secure = (getActivity().getWindow().getAttributes().flags
                    & WindowManager.LayoutParams.FLAG_SECURE) != 0;
        }
        JSObject ret = new JSObject();
        ret.put("secure", secure);
        call.resolve(ret);
    }
}
