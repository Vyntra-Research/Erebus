# Vulnerability report template

Follow a program-supplied template when one exists. Otherwise use only the sections that help a triager understand and reproduce the issue.

## Title

Use one concrete sentence that names the affected boundary and impact.

## CWE

Use the closest CWE. State uncertainty when the classification is not settled.

## Summary

In one or two short paragraphs, explain what breaks, who can trigger it, the high-level root cause, and the realistic impact.

## Root cause

Explain the target-owned mistake and only the technical detail needed to understand it. Omit this section when the summary and reproduction already make it clear.

## PoC details

Explain any state, setup, or helper code needed to trust the proof. Prefer normal browser actions, HTTP requests, or CLI commands. If a script automates the flow, say what manual steps it performs.

## Steps to reproduce

Keep each step to an action and its expected result. Report the exact stable release used.

1.

## Impact

List the proved attacker scenario, affected victim resources, and security consequence. Do not claim impact that the reproduction does not establish.
