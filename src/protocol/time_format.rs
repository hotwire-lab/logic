pub use hotwire_core::format::{
    format_duration, format_frequency, format_resolution, format_signed_duration,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_durations_resolutions_and_frequencies() {
        assert_eq!(format_duration(50e-9), "50.0 ns");
        assert_eq!(format_duration(16.384e-3), "16.4 ms");
        assert_eq!(format_duration(16.384), "16.38 s");
        assert_eq!(format_signed_duration(-100e-6), "-100.0 µs");
        assert_eq!(format_resolution(20_000_000), "50 ns");
        assert_eq!(format_resolution(1_000_000), "1.0 µs");
        assert_eq!(format_resolution(1_000), "1.0 ms");
        assert_eq!(format_frequency(5_000_000.0), "5.00 MHz");
        assert_eq!(format_frequency(25_000.0), "25.00 kHz");
    }
}
