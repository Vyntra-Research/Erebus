# Persistent microVMs

Erebus provides local Microsandbox microVMs for builds, fuzzing, test services, exploit validation, and toolchains that should stay outside the host workspace. Open **Settings → MicroVMs** to inspect, start, stop, resize, or remove them.

## Requirements

MicroVMs require hardware virtualization. Enable Windows Hypervisor Platform on Windows or KVM on Linux. The default guest is a minimal Debian image, so install the compiler, debugger, language runtime, or other tools the task needs.

## Private source copies

An agent can create a VM from a host source directory. Erebus copies that source into the guest instead of mounting the checkout for writes. Builds, fuzzers, and test payloads can change the guest copy without changing the original project.

The agent can choose the image, CPU and memory limits, disk size, working directory, and environment. It can later change resources, run commands with literal arguments, launch detached jobs, read their logs, stop them, and copy files between host and guest. Co-agents can use the same named VM when they need one shared environment.

## Lifecycle

VM disks and configuration persist until removal. A stopped or crashed VM starts automatically when an agent executes a command or copies a file. A graceful stop can briefly show `draining`; wait for it to settle before starting it again.

Restarting Erebus or the computer stops guest processes and detached jobs. The VM's disk, installed tools, source copy, environment, and resource settings remain. Start the VM and relaunch any service, build, or fuzzer that should continue.

Removing a VM deletes its private disk. Erebus refuses to remove an active VM unless the caller explicitly forces the removal. Copy out crashes, reports, corpora, and build artifacts first.

## Network

Guests have outbound network access. Erebus does not publish inbound guest ports. Use a host-side service or another supported route when a test needs an externally reachable listener.
