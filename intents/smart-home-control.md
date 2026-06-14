---
id: SMART_HOME_CONTROL
name: Smart Home & IoT Control (智慧家電與物聯網控制)
enabled: true
triggers:
  - "User wants to control smart home devices: turn on/off, adjust temperature, brightness, color, mode, scenes, or automation state"
  - "User mentions smart home devices or physical spaces: 冷氣, 空調, 燈, 窗簾, 電視, 風扇, 除濕機, 掃地機器人, 溫度, 濕度, 客廳, 臥室"
  - "User gives a terse physical-environment command with a target value or state, such as 26度, 50%, 紅色, 睡覺模式, 關掉, 打開, 調暗"
examples:
  - "冷氣 26"
  - "把客廳的燈關掉"
  - "臥室空調開到 24 度"
  - "窗簾拉上"
  - "現在室內溫度幾度？"
  - "開除濕機"
---

Detected "smart home and IoT control" intent. The user wants to control or query smart home devices, room conditions, or physical environment settings.

## Guidelines

- Treat short commands like "冷氣 26" or "燈暗一點" as actionable smart-home requests when the target device and desired state are inferable.
- Use Home Assistant entities, scripts, or MQTT-backed helpers for device control and sensor queries.
- Distinguish smart-home device control from server, gateway, Kubernetes, or infrastructure operations.
- If the device, room, or desired state is ambiguous, ask one brief clarification before acting.
- For potentially disruptive changes such as alarms, locks, cameras, or safety-related automations, confirm before mutating state.

## Skills & Tools

- Control and query Home Assistant devices, sensors, and scripts:
  skill: home-assistant

- Execute the dedicated AC control script when adjusting the air conditioner:
  exec({ command: "uv run --with paho-mqtt python3 /home/ani/.openclaw/skills/home-assistant/scripts/ac_control.py --power on --temp <temperature>" })

- Query Home Assistant state through its REST API when a readback is needed:
  exec({ command: "curl -s -H \"Authorization: Bearer $HOME_ASSISTANT_ACCESS_TOKEN\" https://home-assistant.weii.cloud/api/states/<entity_id> | jq ." })

## Response Strategy

- Parse the target device, room, and desired state from the user's wording and recent context.
- Execute the safest matching Home Assistant script, service, or state query.
- After a mutation, verify the device state when a reliable readback is available.
- Report the action and resulting state concisely; do not over-explain routine device changes.

## Concrete Workflow

### Step 1 — Parse Device Command

- Identify the device type, location, desired state, and numeric value from the user request.
- Use recent context only when it clearly disambiguates a terse command.

### Step 2 — Map to Home Assistant

- Read local Home Assistant SOPs when entity names, scripts, or device mappings are needed.
- Select the matching entity, script, MQTT helper, or REST API endpoint.

### Step 3 — Execute or Clarify

- If the target and state are clear, perform the control or query operation.
- If more than one device or room could match, ask one concise clarification.

### Step 4 — Verify and Report

- For mutations, query the resulting state when available.
- Report the confirmed setting or state in one concise sentence.
