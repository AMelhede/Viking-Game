export type MuseProtocol = "classic" | "athena";
export type MusePpgMode = "none" | "interleaved" | "per-channel" | "athena";
export interface AthenaDecoderLike {
	reset(): void;
	decode(data: Uint8Array): unknown;
	set_use_device_timestamps(enabled: boolean): void;
	set_clock_kind(kind: string): void;
	set_reorder_window_ms(value: number): void;
}
export type AthenaDecoderFactory = () => AthenaDecoderLike;
export interface AthenaAuxPacket {
	optics: {
		samples: number[];
		channel_count: number;
		timestamps_ms: number[];
	};
	accgyro: {
		samples: number[];
		timestamps_ms: number[];
	};
	battery: {
		samples: number[];
		timestamps_ms: number[];
	};
}
export interface MuseBoardInfo {
	device_name: string;
	sample_rate_hz: number;
	channel_count: number;
	eeg_channel_names: string[];
	board_id: number;
	protocol: MuseProtocol;
	optics_channel_count: number;
	description: string;
}
export interface MuseCharacteristicInfo {
	service_uuid: string;
	characteristics: string[];
	protocol: MuseProtocol;
}
export interface MuseDeviceOptions {
	athenaDecoderFactory?: AthenaDecoderFactory;
	sleepMs?: (ms: number) => Promise<void>;
	logger?: (message: string) => void;
	onDisconnected?: () => void;
}
export declare class MuseBleDevice {
	readonly SERVICE_UUID = "0000fe8d-0000-1000-8000-00805f9b34fb";
	readonly CHAR_UUIDS: {
		readonly command: "273e0001-4c4d-454d-96be-f03bac821358";
		readonly tp9: "273e0003-4c4d-454d-96be-f03bac821358";
		readonly af7: "273e0004-4c4d-454d-96be-f03bac821358";
		readonly af8: "273e0005-4c4d-454d-96be-f03bac821358";
		readonly tp10: "273e0006-4c4d-454d-96be-f03bac821358";
		readonly ppg1: "273e000f-4c4d-454d-96be-f03bac821358";
		readonly ppg2: "273e0010-4c4d-454d-96be-f03bac821358";
		readonly ppg3: "273e0011-4c4d-454d-96be-f03bac821358";
		readonly athenaEeg: "273e0013-4c4d-454d-96be-f03bac821358";
		readonly athenaOther: "273e0014-4c4d-454d-96be-f03bac821358";
	};
	samplingRate: number;
	numEegChannels: number;
	eegNames: string[];
	ppgNames: string[];
	protocol: MuseProtocol;
	isAthena: boolean;
	opticsChannelCount: number;
	availableCharacteristics: string[];
	ppgMode: MusePpgMode;
	private readonly athenaDecoderFactory?;
	private readonly sleepMs;
	private readonly logger?;
	private readonly onDisconnected?;
	private athenaDecoder;
	private device;
	private server;
	private service;
	private commandChar;
	private eegChars;
	private ppgChars;
	private athenaChars;
	private eegBuffers;
	private ppgBuffers;
	private isStreaming;
	private ppgSampleCount;
	private ppgFallbackTimer;
	private onDataCallback;
	private onPpgCallback;
	constructor(options?: MuseDeviceOptions);
	getBoardInfo(): MuseBoardInfo;
	getCharacteristicInfo(): MuseCharacteristicInfo;
	private decodeEegPacket;
	private decodePpgPacket;
	private splitPpgSamples;
	prepareSession(): Promise<void>;
	private sendCommand;
	private processClassicEegBuffers;
	startStream(
		callback: (samples: number[][]) => void,
		ppgCallback?: MuseBleDevice["onPpgCallback"],
	): Promise<void>;
	stopStream(): Promise<void>;
	releaseSession(): Promise<void>;
}
//# sourceMappingURL=museDevice.d.ts.map
