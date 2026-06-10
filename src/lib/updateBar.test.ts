import { describe, expect, test } from "bun:test";
import { updateBarState } from "./updateBar";

describe("updateBarState", () => {
  test("downloading with unknown total is indeterminate (not a fake 35%)", () => {
    const state = updateBarState({ phase: "downloading", downloaded: 0 });
    expect(state).toEqual({ indeterminate: true, percent: null });
  });

  test("downloading with total 0 is indeterminate", () => {
    const state = updateBarState({
      phase: "downloading",
      downloaded: 1024,
      total: 0,
    });
    expect(state).toEqual({ indeterminate: true, percent: null });
  });

  test("downloading with known total computes exact percent", () => {
    const state = updateBarState({
      phase: "downloading",
      downloaded: 5_242_880,
      total: 10_485_760,
    });
    expect(state).toEqual({ indeterminate: false, percent: 50 });
  });

  test("downloading starts at 0% once total is known", () => {
    const state = updateBarState({
      phase: "downloading",
      downloaded: 0,
      total: 73_400_320,
    });
    expect(state).toEqual({ indeterminate: false, percent: 0 });
  });

  test("percent is clamped to 100 when downloaded overshoots total", () => {
    const state = updateBarState({
      phase: "downloading",
      downloaded: 10_500_000,
      total: 10_485_760,
    });
    expect(state).toEqual({ indeterminate: false, percent: 100 });
  });

  test("percent rounds to nearest integer", () => {
    const state = updateBarState({
      phase: "downloading",
      downloaded: 333,
      total: 1000,
    });
    expect(state).toEqual({ indeterminate: false, percent: 33 });
  });

  test("installing is pinned at 100% even with unknown total", () => {
    const state = updateBarState({
      phase: "installing",
      downloaded: 10_485_760,
    });
    expect(state).toEqual({ indeterminate: false, percent: 100 });
  });
});
