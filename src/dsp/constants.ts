/**
 * Sample rate in Hz of the decimated audio that every analysis stage consumes. Its Nyquist limit of 1000 Hz sits above the top of the analysis band while keeping each FFT short.
 */
export const ANALYSIS_SAMPLE_RATE_HZ = 2000;

/**
 * Lowest frequency in Hz of the analysis band in which aircraft Doppler ridges are tracked.
 */
export const ANALYSIS_MIN_FREQ_HZ = 65;

/**
 * Highest frequency in Hz of the analysis band in which aircraft Doppler ridges are tracked.
 */
export const ANALYSIS_MAX_FREQ_HZ = 500;

/**
 * Default spectrogram window length in samples. At the analysis rate it spans 1.024 s and resolves bins of about 0.98 Hz. Must be a power of two for the FFT.
 */
export const SPECTROGRAM_FFT_SIZE = 2048;

/**
 * Spectrogram frames started per second of audio, so that consecutive frames start `1 / SPECTROGRAM_FRAMES_PER_SECOND` seconds apart.
 */
export const SPECTROGRAM_FRAMES_PER_SECOND = 4;

/**
 * Default hop in samples between consecutive spectrogram windows: a quarter of a second at the analysis rate.
 */
export const SPECTROGRAM_HOP_SAMPLES = ANALYSIS_SAMPLE_RATE_HZ / SPECTROGRAM_FRAMES_PER_SECOND;

/**
 * Speed of sound in dry air at 20 degrees Celsius, in metres per second.
 */
export const SPEED_OF_SOUND_MPS = 343;

/**
 * Nominal frequency in Hz of a 50 Hz mains grid (Europe, the UK, Asia, Africa, Australia and eastern Japan).
 */
export const GRID_50_NOMINAL_HZ = 50;

/**
 * Nominal frequency in Hz of a 60 Hz mains grid (North America, South Korea, Taiwan and western Japan).
 */
export const GRID_60_NOMINAL_HZ = 60;

/**
 * Smallest FFT length in samples used for Electric Network Frequency (ENF) detection. At the analysis rate it resolves bins of about 0.49 Hz, fine enough to separate 50 Hz from 60 Hz with room for the neighbouring bins.
 */
export const ENF_MIN_FFT_SIZE = 4096;

/**
 * Largest FFT length in samples used for ENF detection: longer windows add resolution the detector does not use.
 */
export const ENF_MAX_FFT_SIZE = 16_384;

/**
 * Fewest samples an audio buffer may hold for ENF analysis; a shorter buffer is reported as undetected.
 */
export const ENF_MIN_SAMPLES = 512;

/**
 * Lower edge in Hz of the band whose median power estimates the mains-hum noise floor.
 */
export const ENF_BACKGROUND_MIN_HZ = 42;

/**
 * Upper edge in Hz of the band whose median power estimates the mains-hum noise floor.
 */
export const ENF_BACKGROUND_MAX_HZ = 68;

/**
 * Half-width in Hz of the notch around each nominal grid frequency that is excluded from the mains-hum noise-floor estimate, so that the hum itself does not raise its own floor.
 */
export const ENF_NOTCH_HALF_WIDTH_HZ = 1.8;

/**
 * Minimum signal-to-noise ratio in dB at a nominal grid frequency for its mains hum to count as detected.
 */
export const ENF_MIN_SNR_DB = 6;

/**
 * Margin in dB by which one grid's hum must exceed the other's before the detector names it.
 */
export const ENF_DOMINANCE_MARGIN_DB = 2;

/**
 * Power in dB substituted for a spectrum bin that does not exist, far below any recorded level so that it never wins a maximum.
 */
export const MISSING_BIN_POWER_DB = -120;

/**
 * Noise floor in dB reported when a search band holds no background bins to take a median of.
 */
export const NO_BACKGROUND_NOISE_FLOOR_DB = -100;

/**
 * A nominal mains-grid frequency that synthetic audio can carry as electric network hum.
 */
export type NominalGridHz = typeof GRID_50_NOMINAL_HZ | typeof GRID_60_NOMINAL_HZ;
