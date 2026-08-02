# Embedded Linux Dev

Symbol autocompletion, function and symbol navigation. Supports C, Kconfig, defconfig, .config and device tree files. Plus some automation to match device tree compatibles and open their respective driver or documentation files.

## Requirements

The extension works on Linux systems, also tested on WSL, and uses some
packages for its correct operation. Before use you must install the following
dependencies on your system:

- bash
- universal-ctags

An important detail is to install universal-ctags and not exuberant-ctags to have support to index Kconfig and device tree files.

## 🧪 Experimental Kconfig Engine

> A new Kconfig Engine parser is in testing phase. This does not use ctags and it has a totally different behavior.

To use new Kconfig Engine add the following to your `settings.json`:

```json
    "kerneldev.experimental.newKconfigEngine": true
```

Also to have the correct index to the target architecture you must add the following to your `settings.json`:

```json
    "kconfig.env": {
        "SRCARCH": "x86" // or arm, arm64, mips, etc...
    }
```

> ⚠️ To these settings take effect you must reload the VS Code window.

### Integration to Devicetree LSP

This extension automatically integrates to [Devicetree LSP](https://marketplace.visualstudio.com/items?itemName=KyleMicallefBonnici.dts-lsp). This extension contributes the following settings.

```json
    "defaultIncludePaths": ["${workspaceFolder}/include"],
    "defaultBindingType": "DevicetreeOrg",
```

By default the paths to the `defaultDeviceOrgBindingsMetaSchema` and `defaultDeviceOrgTreeBindings` are not set.
[Devicetree LSP](https://marketplace.visualstudio.com/items?itemName=KyleMicallefBonnici.dts-lsp) allow for the above to be
overridden or set by adding these in `settings.json`. See [Devicetree LSP](https://marketplace.visualstudio.com/items?itemName=KyleMicallefBonnici.dts-lsp) documentation for more.


## 🧪 Experimental KGDB Support

Now the extension has built-in tools to be able to easily start a debug session with [KGDB](https://www.kernel.org/doc/html/v4.15/dev-tools/kgdb.html). An example for launch configuration for attach to KGDB:

```json
    {
        "type": "cppdbg",
        "name": "Kernel KDGB",
        "request": "launch",
        "program": "/tmp/kernel/rpi/artifacts/bcm2711-rpi-4b/vmlinux",
        "cwd": "${workspaceFolder}",
        "symbolLoadInfo": {
            "loadAll": false,
            "exceptionList": ""
        },
        "MIMode": "gdb",
        "miDebuggerPath": "/usr/bin/gdb-multiarch",
        "setupCommands": [
            {
                "description": "Enable pretty-printing for gdb",
                "text": "-enable-pretty-printing",
                "ignoreFailures": true
            },
            {
                "text": "set arch aarch64"
            },
            {
                "text": "target remote localhost:${config:kerneldev.kgdb_port}"
            },
        ],
        "preLaunchTask": "${command:embeddedLinuxDev.breakKernel}"
    },
```

There are some properties that need attention:

- `program`
    - It has to be the exactly Kernel `vmlinux` file you are trying to attach the debugger to;
- `miDebuggerPath`
    - You need the `gdb-multiarch` installed on your distro;
- `setupCommands`
    - In the `"text": "set arch aarch64"` you must put the architecture of the target you want to attach the debugger;
- `preLaunchTask`
    - Do not remove the command `${command:embeddedLinuxDev.breakKernel}`. If you need to add a custom task for your use case, don't forget to add the command call in the tasks pipeline as the last task to be executed. Is this command that initializes the `agent-proxy` that will share what is from `gdb` and what is from the session console;

To break the kernel in order to initialize the debug session and correctly send the required breakpoints, the `embeddedLinuxDev.breakKernel` command needs some settings. These are necessary:

```json
    "kerneldev.kgdb_port": "6061",
    "kerneldev.serial_port": "6060",
```

These ports will be used by `agent-proxy` to create telnet sessions to distribute what comes from `gdb` and what comes from the normal Linux console.

The recommended way to put the Linux Kernel in debug mode is by using `Linux Magic System Request Key Hacks`:

```json
    "kerneldev.breakBySysrq": "break"
```

But if you want to execute the break via `ssh`, use:

> ⚠️ Executing the break via `ssh` is especially useful when your serial device does not support `BREAK`

```json
    "kerneldev.breakBySysrq": "ssh",
    "kerneldev.ssh_login": "seadog",
    "kerneldev.ssh_psswd": "seadog",
    "kerneldev.ssh_ip": "192.168.0.53",
```

And if you want to execute the break via `serial`, use:

```json
    "kerneldev.breakBySysrq": "serial",
    "kerneldev.serial_port": "6060",
```

> ⚠️ For this mode work you need to leave a previous serial connection logged in.

> ⚠️ Executing the break via `serial` is especially useful when your serial device supports `BREAK` and you want a more direct way to send the break command without the overhead of `ssh`.


## 🧪 Experimental Crash Utility Debugger Adapter

A debugger adapter for crash utility https://github.com/crash-utility/crash was added. This new debugger adapter has type `crash`, example configuration for the `launch.json`:

```json
    {
        "type": "crash",
        "request": "launch",
        "name": "Run Crash Utility",
        "crash": "/tmp/crash/crash",
        "vmlinux": "/tmp/kernel/rpi/artifacts/bcm2711-rpi-4b/vmlinux",
        "vmcore": "/media/rootfs/var/log/vmcore"
    }
```

Description of properties:

```json
"crash": {
    "type": "string",
    "description": "Absolute path to the crash utility binary"
},
"vmlinux": {
    "type": "string",
    "description": "Absolute path to the Kernel vmlinux with debug symbols"
},
"vmcore": {
    "type": "string",
    "description": "Absolute path to the kdump vmcore"
}
```

## Features

All features of the extension can be accessed by clicking commands through the
activity bar:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/extensionview.gif)

In the next topics, I will describe each of the extension features.

### Device Tree Doc From Compatible

In a device-tree file, ".dts" or ".dtsi", or in a device driver file ".c", mouse
click on a "compatible" string and select the command. VS Code will open the
corresponding documentation file for the compatible:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/devicetreetodocview.gif)

This functionality can also be selected from the right click context menu:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/devicetreetodoccontext.gif)

### Device Driver From Compatible

In a device-tree file, ".dts" or ".dtsi", mouse click on a "compatible" string
and select the command. VS Code will match and open the code file, “.c”, from
the driver that implements compatible:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/devicetreetodriver.gif)

This functionality can also be selected from the right click context menu:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/devicetreetodrivercontext.gif)

### ARM/ARM64 dts/dtsi From Include

In a device-tree file, “.dts” or “.dtsi”, mouse click on the string of a
device-tree include and select the command. VS Code will open the corresponding
file:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/dtsinclude.gif)

This functionality can also be selected from the right click context menu:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/dtsincludecontext.gif)

There are two options for this command, one for ARM and other for ARM64, because
the devices-tree files for each of these archs are on different paths.

### Linux Include From Selected

In ".c", ".dts" or ".dtsi" file, mouse click on an include string and select the
command. VS Code will open the corresponding include:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/linuxinclude.gif)

This functionality can also be selected from the right click context menu:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/linuxincludecontext.gif)

### Generate CTags

Last but not least. This functionality generates a “.vscode-ctags” file in the
root folder that has been opened. This file is the tag index generated by
universal-ctags. This file is required to generate the project code navigation:

- Jump to definition:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/ctagstodefinition.gif)

- Code completion:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/ctagscodecomplete.gif)

- Mouse hover tags:

![](https://raw.githubusercontent.com/microhobby/linuxkerneldev/master/docs/ctagshover.gif)

## Known Issues

You can check and open issues on [Github repo](https://github.com/microhobby/linuxkerneldev/issues)

## Release Notes

Check the [CHANGELOG.md](https://github.com/microhobby/linuxkerneldev/blob/master/CHANGELOG.md)

## Acknowledgment

The work here was only possible because of the [Exuberant CTags](https://marketplace.visualstudio.com/items?itemName=chriswheeldon.exuberant-ctags) extension, which I used as a base. Thanks Chris Wheeldon.

Thanks also to Trond Einar Snekvik who did a great job in creating a [syntax highlighting for Kconfig](https://github.com/trond-snekvik/vscode-kconfig) that I am using here.
