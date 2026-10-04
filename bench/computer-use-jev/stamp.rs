//! A visual synchronization marker for the synthetic fixture, not a GUI heuristic.
pub fn color(stage: usize) -> Option<[u8; 3]> {
    // Distinct stage colors stay disjoint under the six-level renderer tolerance.
    [
        [24, 32, 112],
        [24, 104, 32],
        [112, 24, 32],
        [104, 80, 24],
        [80, 24, 112],
    ]
    .get(stage)
    .copied()
}
