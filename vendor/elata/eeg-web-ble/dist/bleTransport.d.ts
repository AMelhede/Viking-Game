import type { HeadbandTransport, HeadbandTransportStatus } from "@elata-biosciences/eeg-web";
import type { MuseDeviceOptions } from "./museDevice";
export interface BleTransportOptions {
    deviceOptions?: MuseDeviceOptions;
    sourceName?: string;
    device?: BleDeviceLike;
}
interface BleDeviceLike {
    isAthena: boolean;
    samplingRate: number;
    eegNames: string[];
    numEegChannels: number;
    opticsChannelCount: number;
    getBoardInfo(): unknown;
    getCharacteristicInfo(): unknown;
    prepareSession(): Promise<void>;
    releaseSession(): Promise<void>;
    startStream(callback: (samples: number[][]) => void, ppgCallback: (channelName: string, packet: unknown) => void): Promise<void>;
    stopStream(): Promise<void>;
}
export declare class BleTransport implements HeadbandTransport {
    onFrame?: HeadbandTransport["onFrame"];
    onStatus?: (status: HeadbandTransportStatus) => void;
    private readonly device;
    private readonly sourceName;
    private sequenceId;
    private _connected;
    private pendingPpgRows;
    private pendingOptics;
    private pendingAccgyro;
    private pendingBattery;
    private ppgPerChannel;
    constructor(options?: BleTransportOptions);
    getBoardInfo(): unknown;
    getCharacteristicInfo(): unknown;
    getIsAthena(): boolean;
    getEegNames(): string[];
    getOpticsChannelCount(): number;
    private emitStatus;
    private rowsFromFlat;
    private collectPerChannelPpg;
    private handlePpg;
    connect(): Promise<void>;
    /** Connect and begin streaming in one call. Safe to call after stop() — skips
     *  re-pairing if the BLE connection is already active. */
    startStreaming(): Promise<void>;
    disconnect(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
}
export {};
//# sourceMappingURL=bleTransport.d.ts.map