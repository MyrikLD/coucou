// Plan usage events → island state. The relay's status line payload arrives as
// `plan`; whether the relay is installed is asked at launch and after the
// settings window changes it.

import { Bridge, onEvent } from "../core/bridge";
import { loadPlan, parsePlan, storePlan } from "../core/plan";
import { State } from "../core/state";

export async function refreshPlanRelay() {
  State.planRelayInstalled = (await Bridge.statuslineStatus()) ?? false;
  State.notify();
}

export function registerPlanHandlers() {
  State.planUsage = loadPlan();
  void onEvent<unknown>("plan", (limits) => {
    const usage = parsePlan(limits);
    if (!usage) return;
    State.planUsage = usage;
    storePlan(usage);
    State.notify();
  });
  void onEvent<boolean>("statusline-changed", (installed) => {
    State.planRelayInstalled = installed;
    State.notify();
  });
  void refreshPlanRelay();
}
