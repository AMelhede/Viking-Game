import { HEADBAND_FRAME_SCHEMA_VERSION, HeadbandTransportState, asElataError, } from "@elata-biosciences/eeg-web";
import { MuseBleDevice } from "./museDevice";
export class BleTransport {
    constructor(options = {}) {
        this.sequenceId = 0;
        this._connected = false;
        this.pendingPpgRows = [];
        this.pendingOptics = null;
        this.pendingAccgyro = null;
        this.pendingBattery = null;
        this.ppgPerChannel = {
            PPG1: [],
            PPG2: [],
            PPG3: [],
        };
        this.sourceName = options.sourceName || "muse-ble";
        if (!options.device && !options.deviceOptions?.athenaDecoderFactory) {
            console.warn("[BleTransport] No athenaDecoderFactory provided. " +
                "Muse S Athena devices will fail to decode — pass " +
                "athenaDecoderFactory: () => new AthenaWasmDecoder() in deviceOptions.");
        }
        this.device =
            options.device ||
                new MuseBleDevice({
                    ...(options.deviceOptions || {}),
                    onDisconnected: () => {
                        this._connected = false;
                        this.emitStatus(HeadbandTransportState.Disconnected, "gatt disconnected", "BLE_GATT_DISCONNECTED", true);
                    },
                });
    }
    getBoardInfo() {
        return this.device.getBoardInfo();
    }
    getCharacteristicInfo() {
        return this.device.getCharacteristicInfo();
    }
    getIsAthena() {
        return this.device.isAthena;
    }
    getEegNames() {
        return this.device.eegNames.slice();
    }
    getOpticsChannelCount() {
        return this.device.opticsChannelCount;
    }
    emitStatus(state, reason, errorCode, recoverable) {
        if (!this.onStatus)
            return;
        this.onStatus({
            state,
            atMs: performance.now(),
            reason,
            errorCode,
            recoverable,
        });
    }
    rowsFromFlat(samples, channelCount) {
        if (!samples || !channelCount || channelCount <= 0)
            return [];
        const out = [];
        const sampleCount = Math.floor(samples.length / channelCount);
        for (let i = 0; i < sampleCount; i++) {
            const row = new Array(channelCount);
            const base = i * channelCount;
            for (let ch = 0; ch < channelCount; ch++)
                row[ch] = samples[base + ch];
            out.push(row);
        }
        return out;
    }
    collectPerChannelPpg() {
        const minLen = Math.min(this.ppgPerChannel.PPG1.length, this.ppgPerChannel.PPG2.length, this.ppgPerChannel.PPG3.length);
        if (minLen <= 0)
            return;
        const rows = [];
        for (let i = 0; i < minLen; i++) {
            rows.push([
                this.ppgPerChannel.PPG1.shift(),
                this.ppgPerChannel.PPG2.shift(),
                this.ppgPerChannel.PPG3.shift(),
            ]);
        }
        this.pendingPpgRows.push(...rows);
    }
    handlePpg(channelName, packet) {
        if (!packet)
            return;
        if (channelName === "athena") {
            const athena = packet;
            const optics = athena.optics;
            if (optics && optics.samples.length > 0) {
                const channelCount = optics.channel_count || this.device.opticsChannelCount || 0;
                const rows = this.rowsFromFlat(optics.samples, channelCount);
                if (rows.length > 0) {
                    this.pendingOptics = {
                        sampleRateHz: 64,
                        channelNames: Array.from({ length: channelCount }, (_, i) => `OPTICS${i + 1}`),
                        channelCount,
                        samples: rows,
                        timestampsMs: optics.timestamps_ms || [],
                        clockSource: "device",
                    };
                }
            }
            const accgyro = athena.accgyro;
            if (accgyro && accgyro.samples.length > 0) {
                const rows = this.rowsFromFlat(accgyro.samples, 6);
                if (rows.length > 0) {
                    this.pendingAccgyro = {
                        sampleRateHz: 52,
                        channelNames: [
                            "ACC_X",
                            "ACC_Y",
                            "ACC_Z",
                            "GYRO_X",
                            "GYRO_Y",
                            "GYRO_Z",
                        ],
                        channelCount: 6,
                        samples: rows,
                        timestampsMs: accgyro.timestamps_ms || [],
                        clockSource: "device",
                    };
                }
            }
            const battery = athena.battery;
            if (battery && battery.samples.length > 0) {
                this.pendingBattery = {
                    samples: battery.samples.slice(),
                    timestampsMs: battery.timestamps_ms || [],
                    clockSource: "device",
                };
            }
            return;
        }
        if (channelName === "interleaved") {
            const interleaved = packet;
            const count = Math.min(interleaved.ir.length, interleaved.nearIr.length, interleaved.red.length);
            for (let i = 0; i < count; i++) {
                this.pendingPpgRows.push([
                    interleaved.ir[i],
                    interleaved.nearIr[i],
                    interleaved.red[i],
                ]);
            }
            return;
        }
        if (channelName !== "PPG1" &&
            channelName !== "PPG2" &&
            channelName !== "PPG3")
            return;
        const ppg = packet;
        if (!ppg.samples || ppg.samples.length === 0)
            return;
        this.ppgPerChannel[channelName].push(...ppg.samples);
        this.collectPerChannelPpg();
    }
    async connect() {
        this.emitStatus(HeadbandTransportState.Connecting);
        try {
            await this.device.prepareSession();
            this._connected = true;
            this.emitStatus(HeadbandTransportState.Connected);
        }
        catch (e) {
            const err = asElataError(e, {
                code: "BLE_CONNECT_FAILED",
                message: "Failed to connect to BLE device",
            });
            this.emitStatus(HeadbandTransportState.Error, err.message, err.code, err.recoverable);
            throw err;
        }
    }
    /** Connect and begin streaming in one call. Safe to call after stop() — skips
     *  re-pairing if the BLE connection is already active. */
    async startStreaming() {
        if (!this._connected) {
            await this.connect();
        }
        await this.start();
    }
    async disconnect() {
        try {
            await this.device.releaseSession();
            this._connected = false;
            this.emitStatus(HeadbandTransportState.Disconnected);
        }
        catch (e) {
            const err = asElataError(e, {
                code: "BLE_DISCONNECT_FAILED",
                message: "Failed to disconnect BLE device",
            });
            this.emitStatus(HeadbandTransportState.Error, err.message, err.code, err.recoverable);
            throw err;
        }
    }
    async start() {
        this.emitStatus(HeadbandTransportState.Streaming);
        try {
            await this.device.startStream((samples) => {
                this.sequenceId += 1;
                const frame = {
                    schemaVersion: HEADBAND_FRAME_SCHEMA_VERSION,
                    source: this.sourceName,
                    sequenceId: this.sequenceId,
                    emittedAtMs: performance.now(),
                    eeg: {
                        sampleRateHz: this.device.samplingRate,
                        channelNames: this.device.eegNames.slice(),
                        channelCount: this.device.numEegChannels,
                        samples: samples.map((row) => row.slice()),
                        clockSource: this.device.isAthena ? "device" : "local",
                    },
                };
                if (this.pendingPpgRows.length > 0) {
                    frame.ppgRaw = {
                        sampleRateHz: 64,
                        channelNames: ["PPG1", "PPG2", "PPG3"],
                        channelCount: 3,
                        samples: this.pendingPpgRows.splice(0, this.pendingPpgRows.length),
                        clockSource: "local",
                    };
                }
                if (this.pendingOptics) {
                    frame.optics = this.pendingOptics;
                    this.pendingOptics = null;
                }
                if (this.pendingAccgyro) {
                    frame.accgyro = this.pendingAccgyro;
                    this.pendingAccgyro = null;
                }
                if (this.pendingBattery) {
                    frame.battery = this.pendingBattery;
                    this.pendingBattery = null;
                }
                if (this.onFrame && frame.eeg.samples.length > 0)
                    this.onFrame(frame);
            }, (channelName, packet) => {
                this.handlePpg(channelName, packet);
            });
        }
        catch (e) {
            const err = asElataError(e, {
                code: "BLE_START_FAILED",
                message: "Failed to start BLE streaming",
            });
            this.emitStatus(HeadbandTransportState.Error, err.message, err.code, err.recoverable);
            throw err;
        }
    }
    async stop() {
        try {
            await this.device.stopStream();
            this.emitStatus(HeadbandTransportState.Connected);
        }
        catch (e) {
            const err = asElataError(e, {
                code: "BLE_STOP_FAILED",
                message: "Failed to stop BLE streaming",
            });
            this.emitStatus(HeadbandTransportState.Error, err.message, err.code, err.recoverable);
            throw err;
        }
    }
}
