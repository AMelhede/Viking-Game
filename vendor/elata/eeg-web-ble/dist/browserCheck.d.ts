export type BluetoothSupportResult = {
    supported: true;
} | {
    supported: false;
    isIOS: boolean;
    message: string;
};
/**
 * Checks whether Web Bluetooth is available in the current browser.
 *
 * On iOS, the standard Chrome and Safari apps do not expose the Web Bluetooth
 * API — only Bluefy (a dedicated browser) does. This function returns an
 * actionable message so the caller can guide the user to install the right
 * browser.
 */
export declare function checkWebBluetooth(): BluetoothSupportResult;
//# sourceMappingURL=browserCheck.d.ts.map