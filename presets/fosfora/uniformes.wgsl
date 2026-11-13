
struct PhosphorUniforms {
    time: f32,
    delta_time: f32,
    resolution: vec2f,

    sub_bass: f32,
    bass: f32,
    low_mid: f32,
    mid: f32,
    upper_mid: f32,
    presence: f32,
    brilliance: f32,
    rms: f32,

    kick: f32,
    centroid: f32,
    flux: f32,
    flatness: f32,
    rolloff: f32,
    bandwidth: f32,
    zcr: f32,
    onset: f32,
    beat: f32,
    beat_phase: f32,
    bpm: f32,
    beat_strength: f32,

    params: array<vec4f, 4>,
    feedback_decay: f32,
    frame_index: f32,

    dominant_chroma: f32,
    scroll_phase: f32,
    mfcc: array<vec4f, 4>,     // 13 MFCCs (indices 0-12 used, 13-15 padding)
    chroma: array<vec4f, 3>,   // 12 pitch class energies (C=0, C#=1, ..., B=11)

    // Reserved audio features (batched ABI bump #1505) — 0.0 until each detector lands.
    loudness_m: f32,       // A10 momentary loudness (#1461)
    loudness_s: f32,       // A10 short-term loudness
    loudness_trend: f32,   // A10 loudness slope/direction
    key_class: f32,        // A11 key root pitch class / 11 (#1462)
    key_is_minor: f32,     // A11 0.0 major, 1.0 minor
    key_confidence: f32,   // A11 key estimate confidence
    downbeat: f32,         // A12 1.0 on bar-start frame (#1463)
    bar_phase: f32,        // A12 0-1 sawtooth over the current bar
    beat_in_bar: f32,      // A12 beat index within the bar, 0-1
    pan: f32,              // A13 stereo balance, 0..1 (#1464)
    stereo_width: f32,     // A13 mid/side width
    stereo_corr: f32,      // A13 L/R correlation, 0..1
    section_novelty: f32,  // A18 self-similarity novelty (#1469)
    buildup: f32,          // A18 riser/tension estimate
    drop: f32,             // A18 drop/impact detection

    // Reserved audio features (batched ABI bump #1629, "v3") — 0.0 until each detector lands.
    percussive_energy: f32, // A14 transient energy, dB-mapped 0-1 (#1465)
    harmonic_energy: f32,   // A14 sustained energy, dB-mapped 0-1
    harmonic_ratio: f32,    // A14 harmonic vs percussive balance, 0-1
    pitch: f32,             // A15 log-frequency f0, 0-1 (#1466)
    pitch_confidence: f32,  // A15 YIN dip confidence, 0-1
    contrast_0: f32,        // A16 spectral contrast band ~200 Hz (#1467)
    contrast_1: f32,        // A16 ~400 Hz
    contrast_2: f32,        // A16 ~800 Hz
    contrast_3: f32,        // A16 ~1600 Hz
    contrast_4: f32,        // A16 ~3200 Hz
    contrast_5: f32,        // A16 ~6400 Hz+
    contrast_mean: f32,     // A16 mean contrast across bands
    timbre_flux: f32,       // A16 L2 norm of the delta-MFCC vector
    // A13b (#1801) per-band pan: where each of the 7 bands sits in the stereo image.
    // 0.5 = centred, 0 = hard left, 1 = hard right; a band with no energy holds 0.5.
    // Same band order as sub_bass..brilliance above. Read it with band_pan(i).
    band_pan: array<vec4f, 2>,

    // Overlay clock (v4): monotonic 0-based counters, stepping by 1 exactly when the
    // matching phase sawtooth wraps — `bar_index + bar_phase` is a continuous multi-bar
    // clock (raw counts, exact to 2^24).
    bar_index: f32,
    beat_index: f32,
    // Tempo trust (#81): how far recent tempo evidence agrees with the grid (0-1), and
    // 1.0 while the tempo is locked. Gate strobes on beat_locked to keep them off an
    // unconfirmed grid.
    tempo_confidence: f32,
    beat_locked: f32,
}

@group(0) @binding(0) var<uniform> u: PhosphorUniforms;
@group(0) @binding(1) var prev_frame: texture_2d<f32>;
@group(0) @binding(2) var prev_sampler: sampler;
// A17 audio textures (#1505) — 1x1 placeholders until the A17 DSP uploads real data.
@group(0) @binding(3) var audio_waveform: texture_2d<f32>;    // Rg16Float 1024x1: r=min, g=max
@group(0) @binding(4) var audio_spectrum: texture_2d<f32>;    // R16Float 512x1: log-magnitude
@group(0) @binding(5) var audio_spectrogram: texture_2d<f32>; // R8Unorm mel x frames history
@group(0) @binding(6) var audio_sampler: sampler;

fn param(i: u32) -> f32 {
    return u.params[i / 4u][i % 4u];
}

fn mfcc(i: u32) -> f32 {
    return u.mfcc[i / 4u][i % 4u];
}

fn chroma_val(i: u32) -> f32 {
    return u.chroma[i / 4u][i % 4u];
}

// A13b per-band pan, i in 0..6 (sub_bass, bass, low_mid, mid, upper_mid, presence, brilliance).
fn band_pan(i: u32) -> f32 {
    return u.band_pan[i / 4u][i % 4u];
}

fn feedback(uv: vec2f) -> vec4f {
    return textureSample(prev_frame, prev_sampler, uv);
}

// A17 audio-texture accessors (x in 0..1). Placeholder textures return 0.0
// until the A17 DSP lands.
fn waveform(x: f32) -> vec2f {
    return textureSampleLevel(audio_waveform, audio_sampler, vec2f(x, 0.5), 0.0).rg;
}

fn spectrum(x: f32) -> f32 {
    return textureSampleLevel(audio_spectrum, audio_sampler, vec2f(x, 0.5), 0.0).r;
}

fn spectrogram(uv: vec2f) -> f32 {
    return textureSampleLevel(audio_spectrogram, audio_sampler, uv, 0.0).r;
}
