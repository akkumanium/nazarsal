export const TRAVEL_MODES = ["walk", "drive"] as const;
export type TravelMode = typeof TRAVEL_MODES[number];
