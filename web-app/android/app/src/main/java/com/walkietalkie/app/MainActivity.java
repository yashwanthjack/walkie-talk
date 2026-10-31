package com.walkietalkie.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    private static final int AUDIO_PERMISSION_REQUEST_CODE = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onStart() {
        super.onStart();

        // Request runtime permissions for RECORD_AUDIO and MODIFY_AUDIO_SETTINGS
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] needed = new String[]{
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.MODIFY_AUDIO_SETTINGS
            };
            boolean allGranted = true;
            for (String perm : needed) {
                if (ContextCompat.checkSelfPermission(this, perm)
                        != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (!allGranted) {
                ActivityCompat.requestPermissions(this, needed, AUDIO_PERMISSION_REQUEST_CODE);
            }
        }

        // Set a BridgeWebChromeClient that auto-grants WebRTC permission requests
        Bridge bridge = getBridge();
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
                @Override
                public void onPermissionRequest(@NonNull final PermissionRequest request) {
                    runOnUiThread(() -> request.grant(request.getResources()));
                }
            });
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }
}
