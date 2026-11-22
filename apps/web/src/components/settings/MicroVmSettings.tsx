import type { MicroVmInfo } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BoxIcon,
  CircleStopIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "The microVM operation failed.";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Disk size unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function removeRequiresForce(status: MicroVmInfo["status"]): boolean {
  return status !== "created" && status !== "stopped" && status !== "crashed";
}

function MicroVmCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const create = useAtomCommand(serverEnvironment.createMicroVm, { reportFailure: false });
  const [name, setName] = useState("");
  const [image, setImage] = useState("debian");
  const [cpus, setCpus] = useState("2");
  const [memory, setMemory] = useState("2048");
  const [sourcePath, setSourcePath] = useState("");
  const [pending, setPending] = useState(false);

  const submit = useCallback(async () => {
    if (environmentId === null || pending) return;
    setPending(true);
    const result = await create({
      environmentId,
      input: {
        ...(name.trim() ? { name: name.trim() } : {}),
        image: image.trim() || "debian",
        cpus: Number(cpus),
        memoryMiB: Number(memory),
        ...(sourcePath.trim() ? { sourcePath: sourcePath.trim() } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      onOpenChange(false);
      onCreated();
      toastManager.add({ type: "success", title: `${result.value.name} created` });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not create microVM",
        description: errorMessage(squashAtomCommandFailure(result)),
      }),
    );
  }, [
    cpus,
    create,
    environmentId,
    image,
    memory,
    name,
    onCreated,
    onOpenChange,
    pending,
    sourcePath,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogPanel>
          <DialogHeader>
            <DialogTitle>Create microVM</DialogTitle>
            <DialogDescription>
              Create a persistent Microsandbox environment. A source directory is copied into a
              private guest workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium">
              Name
              <Input
                nativeInput
                value={name}
                placeholder="Automatic"
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Image
              <Input
                nativeInput
                value={image}
                onChange={(event) => setImage(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              CPUs
              <Input
                nativeInput
                type="number"
                min={1}
                value={cpus}
                onChange={(event) => setCpus(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Memory (MiB)
              <Input
                nativeInput
                type="number"
                min={128}
                value={memory}
                onChange={(event) => setMemory(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium sm:col-span-2">
              Copy source directory
              <Input
                nativeInput
                value={sourcePath}
                placeholder="Optional absolute path"
                onChange={(event) => setSourcePath(event.currentTarget.value)}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void submit()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function MicroVmEditDialog({
  vm,
  open,
  onOpenChange,
  onSaved,
}: {
  vm: MicroVmInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const modify = useAtomCommand(serverEnvironment.modifyMicroVm, { reportFailure: false });
  const [cpus, setCpus] = useState("");
  const [memory, setMemory] = useState("");
  const [maxCpus, setMaxCpus] = useState("");
  const [maxMemory, setMaxMemory] = useState("");
  const [rootDisk, setRootDisk] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [apply, setApply] = useState<"now" | "next-start" | "restart">("now");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open || vm === null) return;
    setCpus(String(vm.cpus));
    setMemory(String(vm.memoryMiB));
    setMaxCpus(String(vm.maxCpus));
    setMaxMemory(String(vm.maxMemoryMiB));
    setRootDisk(vm.rootDiskMiB === null ? "" : String(vm.rootDiskMiB));
    setWorkdir(vm.workdir);
    setApply("now");
  }, [open, vm]);

  const submit = useCallback(async () => {
    if (environmentId === null || vm === null || pending) return;
    setPending(true);
    const result = await modify({
      environmentId,
      input: {
        name: vm.name,
        cpus: Number(cpus),
        memoryMiB: Number(memory),
        maxCpus: Number(maxCpus),
        maxMemoryMiB: Number(maxMemory),
        ...(rootDisk.trim() ? { rootDiskMiB: Number(rootDisk) } : {}),
        workdir: workdir.trim() || vm.workdir,
        apply,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      onOpenChange(false);
      onSaved();
      toastManager.add({ type: "success", title: `${vm.name} updated` });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not update ${vm.name}`,
        description: errorMessage(squashAtomCommandFailure(result)),
      }),
    );
  }, [
    apply,
    cpus,
    environmentId,
    maxCpus,
    maxMemory,
    memory,
    modify,
    onOpenChange,
    onSaved,
    pending,
    rootDisk,
    vm,
    workdir,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogPanel>
          <DialogHeader>
            <DialogTitle>Configure {vm?.name ?? "microVM"}</DialogTitle>
            <DialogDescription>
              Change active resources, limits, storage, and the default working directory.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium">
              CPUs
              <Input
                nativeInput
                type="number"
                min={1}
                value={cpus}
                onChange={(event) => setCpus(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Maximum CPUs
              <Input
                nativeInput
                type="number"
                min={1}
                value={maxCpus}
                onChange={(event) => setMaxCpus(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Memory (MiB)
              <Input
                nativeInput
                type="number"
                min={128}
                value={memory}
                onChange={(event) => setMemory(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Maximum memory (MiB)
              <Input
                nativeInput
                type="number"
                min={128}
                value={maxMemory}
                onChange={(event) => setMaxMemory(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Root disk (MiB)
              <Input
                nativeInput
                type="number"
                min={1}
                value={rootDisk}
                placeholder="Keep current"
                onChange={(event) => setRootDisk(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Apply
              <select
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                value={apply}
                onChange={(event) => setApply(event.currentTarget.value as typeof apply)}
              >
                <option value="now">Now</option>
                <option value="next-start">Next start</option>
                <option value="restart">Restart</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium sm:col-span-2">
              Working directory
              <Input
                nativeInput
                value={workdir}
                onChange={(event) => setWorkdir(event.currentTarget.value)}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void submit()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function MicroVmSettings() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.microVms({ environmentId, input: {} }),
  );
  const control = useAtomCommand(serverEnvironment.controlMicroVm, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.removeMicroVm, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editVm, setEditVm] = useState<MicroVmInfo | null>(null);

  const runControl = useCallback(
    async (vm: MicroVmInfo, action: "start" | "stop" | "restart") => {
      if (environmentId === null || busy !== null) return;
      setBusy(vm.name);
      const result = await control({ environmentId, input: { name: vm.name, action } });
      setBusy(null);
      if (result._tag === "Success") {
        refresh();
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not ${action} ${vm.name}`,
          description: errorMessage(squashAtomCommandFailure(result)),
        }),
      );
    },
    [busy, control, environmentId, refresh],
  );

  const runRemove = useCallback(
    async (vm: MicroVmInfo) => {
      if (environmentId === null || busy !== null) return;
      if (!window.confirm(`Permanently remove ${vm.name} and its private disk?`)) return;
      setBusy(vm.name);
      const result = await remove({
        environmentId,
        input: { name: vm.name, force: removeRequiresForce(vm.status) },
      });
      setBusy(null);
      if (result._tag === "Success") {
        refresh();
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not remove ${vm.name}`,
          description: errorMessage(squashAtomCommandFailure(result)),
        }),
      );
    },
    [busy, environmentId, refresh, remove],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="microvms"
        title="MicroVMs"
        icon={<BoxIcon className="size-4" />}
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Refresh microVMs"
              onClick={refresh}
            >
              <RefreshCwIcon className={isPending ? "size-3.5 animate-spin" : "size-3.5"} />
            </Button>
            <Button size="xs" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-3.5" /> Create
            </Button>
          </div>
        }
      >
        {data?.sandboxes.length ? (
          data.sandboxes.map((vm) => {
            const running = vm.status === "running" || vm.status === "starting";
            const disabled = busy !== null;
            return (
              <SettingsRow
                key={vm.id}
                title={vm.name}
                description={`${vm.image} · ${vm.cpus}/${vm.maxCpus} CPU · ${vm.memoryMiB}/${vm.maxMemoryMiB} MiB · ${formatBytes(vm.storageBytes)}`}
                status={
                  <span className="text-xs capitalize text-muted-foreground">{vm.status}</span>
                }
                control={
                  <div className="flex items-center gap-1">
                    {running ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Stop ${vm.name}`}
                        disabled={disabled}
                        onClick={() => void runControl(vm, "stop")}
                      >
                        <CircleStopIcon className="size-3.5" />
                      </Button>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Start ${vm.name}`}
                        disabled={disabled}
                        onClick={() => void runControl(vm, "start")}
                      >
                        <PlayIcon className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Restart ${vm.name}`}
                      disabled={disabled}
                      onClick={() => void runControl(vm, "restart")}
                    >
                      <RotateCwIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Configure ${vm.name}`}
                      disabled={disabled}
                      onClick={() => setEditVm(vm)}
                    >
                      <Settings2Icon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Remove ${vm.name}`}
                      disabled={disabled}
                      onClick={() => void runRemove(vm)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                }
              />
            );
          })
        ) : (
          <SettingsRow
            title={isPending ? "Loading microVMs…" : "No microVMs yet"}
            description={
              error
                ? errorMessage(error)
                : "Agents can create persistent environments, or you can create one here."
            }
          />
        )}
        <SettingsRow
          title="Storage"
          description={
            data
              ? `Managed by Microsandbox at ${data.home}`
              : "Persistent VM state is stored with Erebus data."
          }
        />
      </SettingsSection>
      <MicroVmCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} />
      <MicroVmEditDialog
        vm={editVm}
        open={editVm !== null}
        onOpenChange={(open) => {
          if (!open) setEditVm(null);
        }}
        onSaved={refresh}
      />
    </SettingsPageContainer>
  );
}
