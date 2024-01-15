# Embedded Linux Dev

Symbol autocompletion, function and symbol navigation. Supports C, Kconfig, defconfig, .config and device tree files. Plus some automation to match device tree compatibles and open their respective driver or documentation files.

## Requirements

The extension works on Linux systems, also tested on WSL, and uses some
packages for its correct operation. Before use you must install the following
dependencies on your system:

- bash
- universal-ctags

An important detail is to install universal-ctags and not exuberant-ctags to have support to index Kconfig and device tree files.

## 🧪 Experimental Device Tree Source Engine

> A new DTS Engine parser is in testing phase. This does not use ctags and it has a totally different behavior showing hints and lookups just for the included files.

### Requirements

The new DTS engine validate and compile the device tree source using the device tree compiler `dtc`. Before use you must install the following
dependencies on your system:

- device-tree-compiler

### Enabling Experimental DTS Engine

To use new DTS Engine add the following to your `settings.json`:

```json
    "kerneldev.experimental.newDtsEngine": true
```

Changing this configuration and saving will automatically reload the extension to make effect.

Also make sure to remove the `DTS` from the `ctags.languages`. The default configuration is:

```json
    "ctags.languages": [
        "C",
        "C++",
        "DTS",
        "Kconfig",
        "Make"
    ],
```

The new DTS Engine uses the `yaml` binding documentation to have completion tips and validation. The extension needs to know a valid path to documentation. If you are opening the root folder from Linux Kernel source code add the following to your `settings.json`:

```json
    "devicetree.bindings": [
        "${workspaceFolder}/Documentation/devicetree/bindings"
    ],
```

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

Para realizar o break do Kernel para inicializar a sessão de debug e enviar corretamente os breakpoints requeridos o comando `embeddedLinuxDev.breakKernel` precisa de alguns settings. São nexessários:

```json
    "kerneldev.kgdb_port": "6061",
    "kerneldev.serial_port": "6060",
```

Essas portas serão utitilizadas pelo `agent-proxy` para criar sessões telnet para distribuir o que é do `gdb` e o que é do console normal do linux.

O modo recomendado de colocar o Kernel Linux em modo de debug e por `Linux Magic System Request Key Hacks`:

```json
    "kerneldev.breakBySysrq": true
```

Mas caso queira executar o break via `ssh` use:

> ⚠️ Executar o break via `ssh` é especialmente útil quando o seu device serial não suporta `BREAK`

```json
    "kerneldev.breakBySysrq": false,
    "kerneldev.ssh_login": "seadog",
    "kerneldev.ssh_psswd": "seadog",
    "kerneldev.ssh_ip": "192.168.0.53",
```

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
