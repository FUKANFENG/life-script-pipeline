export const AUDIO_SAMPLE_RATE = 48_000;
export const ROUNDING_POLICY = "nearest_frame_ties_to_even" as const;

export type VideoTimebase = {
    fps_num: number;
    fps_den: number;
};

/** 将音频采样位置映射为最近视频帧，正好半帧时舍入到偶数帧。 */
export function samplesToFrames(samples: number, timebase: VideoTimebase): number {
    assertNonNegativeInteger(samples, "samples");
    return roundRationalTiesToEven(
        BigInt(samples) * BigInt(timebase.fps_num),
        BigInt(AUDIO_SAMPLE_RATE) * BigInt(timebase.fps_den),
    );
}

/** 将视频帧位置映射为最近音频采样，正好半采样时舍入到偶数采样。 */
export function framesToSamples(frames: number, timebase: VideoTimebase): number {
    assertNonNegativeInteger(frames, "frames");
    return roundRationalTiesToEven(
        BigInt(frames) * BigInt(AUDIO_SAMPLE_RATE) * BigInt(timebase.fps_den),
        BigInt(timebase.fps_num),
    );
}

export function framesToSeconds(frames: number, timebase: VideoTimebase): number {
    return frames * timebase.fps_den / timebase.fps_num;
}

export function samplesToSeconds(samples: number): number {
    return samples / AUDIO_SAMPLE_RATE;
}

function roundRationalTiesToEven(numerator: bigint, denominator: bigint): number {
    if (denominator <= 0n) throw new RangeError("时间基准分母必须大于 0");
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const doubled = remainder * 2n;
    const rounded = doubled < denominator
        ? quotient
        : doubled > denominator
            ? quotient + 1n
            : quotient % 2n === 0n ? quotient : quotient + 1n;
    const output = Number(rounded);
    if (!Number.isSafeInteger(output)) throw new RangeError("时间值超出 JavaScript 安全整数范围");
    return output;
}

function assertNonNegativeInteger(value: number, name: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} 必须是非负安全整数`);
    }
}
