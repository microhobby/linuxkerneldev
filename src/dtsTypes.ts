/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as yaml from 'js-yaml';
import * as glob from 'glob';
import * as vscode from 'vscode';
import * as path from 'path';
import { PathLike, readFile, readFileSync, readSync } from 'fs';
import { Node } from './dts';
import * as DTSEngine from './DTSEngine';

export interface PropertyType {
    name: string;
    required: boolean;
    enum?: (string | number)[];
    const?: string | number;
    default?: any;
    type: string | string[];
    description?: string;
    constraint?: string;
    node?: NodeType;
}

type PropertyTypeMap = { [name: string]: PropertyType };

interface PropertyFilter {
    allow?: string[];
    block?: string[];
}

interface TypeInclude extends PropertyFilter {
    name: string;
    allow?: string[];
    block?: string[];
    childBinding?: boolean;
}

function filterProperties(props: PropertyTypeMap, filter: PropertyFilter): string[] {
    if (!filter.allow && !filter.block) {
        return Object.keys(props);
    }

    return Object.keys(props).filter(
        (name) =>
            (
                (!filter.allow || filter.allow.includes(name)) &&
                (!filter.block || !filter.block.includes(name))
            )
    );
}

export class NodeType {
    private _properties: PropertyTypeMap;
    private _include: TypeInclude[];
    private _cells: {[cell: string]: string[]};
    private _bus: string;
    private _onBus: string;
    private _isChild = false;
    readonly filename?: string;
    readonly compatible: string;
    readonly valid: boolean = true;
    readonly description?: string;
    readonly child?: NodeType;
    private loader?: TypeLoader;

    constructor(private tree: any, filename?: string) {
        this._onBus = tree['on-bus'];
        this._bus = tree['bus'];
        this._cells = {};
        Object.keys(tree).filter(k => k.endsWith('-cells')).forEach(k => {
            this._cells[k.slice(0, k.length - '-cells'.length)] = tree[k];
        });
        
        // I really wanted the Linux Kernel to use something simpler like Zephyr
        this.compatible = 
            tree.compatible ??
            tree.properties?.compatible?.const ??
            tree.properties?.compatible?.oneOf?.[0]?.const ??
            tree.name;
        
        this.description = tree.description;
        this.filename = filename;

        const childIncludes = new Array<{[key: string]: any}>();

        // includes may either be an array of strings or an array of objects with "include"
        const processInclude = (i: string | {[key: string]: any}): TypeInclude => {
            if (typeof(i) === 'string') {
                return {
                    // remove .yaml file extension:
                    name: i.split('.')[0],
                };
            }

            const incl = {
                // remove .yaml file extension:
                name: i.name.split('.')[0],
                block: i['property-blocklist'],
                allow: i['property-allowlist'],
            } as TypeInclude;

            // Child binding includes are transferred to the child's tree:
            childIncludes.push({
                name: incl.name,
                ...i['patternProperties'],
            });

            return incl;
        };

        if (Array.isArray(tree.include)) {
            this._include = tree.include.map(processInclude);
        } else if (tree.include) {
            this._include = [processInclude(tree.include)];
        } else {
            this._include = [];
        }

        this._properties = tree.properties ?? {};

        // we have some $ref?
        if (tree.properties?.$ref != null) {
            const base = path.dirname(filename);
            const file = tree.properties.$ref;
            const concas = this.deferenceRef(base, file);
            this._properties = Object.assign(this._properties, concas);
        }

        // add the default ones for everyone
        this._properties = Object.assign(this._properties, standardProperties);

        for (const name in this._properties) {
            //if (typeof this._properties[name] == "object") {
                this._properties[name].name = name;
                this._properties[name].node = this;
            //}
        }

        if ('patternProperties' in tree) {
            // get the properties from all father patternProperties
            const keys = Object.keys(tree['patternProperties']);
            let allPropertiesFromKeys: any = {
                properties: {}
            };
            for (let i = 0; i < keys.length; i++) {
                if (tree['patternProperties'][keys[i]].properties != null) {
                    allPropertiesFromKeys.properties =
                        Object.assign(
                            allPropertiesFromKeys.properties,
                            tree['patternProperties'][keys[i]].properties);

                    if (tree['patternProperties'][keys[i]].$ref != null) {
                        const base = path.dirname(filename);
                        const file = tree['patternProperties'][keys[i]].$ref;
                        const concas = this.deferenceRef(base, file);
                        allPropertiesFromKeys.properties =
                            Object.assign(
                                allPropertiesFromKeys.properties, concas);
                    }
                }
            }

            // Transfer the child binding property list to the child type, so it can
            // handle it the same way parent types do:
            tree['patternProperties'].include = childIncludes;
            //this.child = new NodeType(tree['patternProperties']);
            this.child = new NodeType(allPropertiesFromKeys);
            this.child._isChild = true;
        }

        return this;
    }

    private deferenceRef (basePath: PathLike, fileRef: string): any {
        try {
            fileRef = fileRef.replace("#", "");

            if (fileRef.startsWith("/schema")) {
                const dirs = DTSEngine.getBindingDirs();
                let props: any = {};
            
                for (let i = 0; i < dirs.length; i++) {
                    const fileSchema = fileRef.replace("/schemas", dirs[i]);
                    const out = readFileSync(fileSchema);
                    const tree: any = yaml.load(out.toString(), { json: true });
                    
                    if (tree.properties != null) {
                        Object.assign(props, tree.properties);
                    }
                }

                return props;
            } else {
                const out = readFileSync(path.join(basePath.toString(), fileRef));
                const tree: any = yaml.load(out.toString(), { json: true });
                
                if (tree.properties != null) {
                    return tree.properties;
                }
            }
        } catch (error) {
            // propably ENOENT
            return undefined;
        }
    }

    setLoader(loader: TypeLoader) {
        this.loader = loader;
        this.child?.setLoader(loader);
    }

    private get inclusions(): NodeType[] {
        return this._include.flatMap(i => this.loader?.get(i.name) ?? []);
    }

    includes(name: string) {
        return this.inclusions.find(i => i.name === name);
    }

    cells(type: string): string[] {
        if (type.endsWith('-cells')) {
            type = type.slice(0, type.length - '-cells'.length);
        }

        return this._cells[type] ?? this.inclusions.find(i => i.cells(type))?.cells(type);
    }

    /// Whether this type matches the given type string, either directly or through inclusions
    is(type: string): boolean {
        return this.name === type || !!this.includes(type);
    }

    get bus(): string {
        return this._bus ?? this.inclusions.find(i => i.bus)?.bus;
    }

    get onBus(): string {
        return this._onBus ?? this.inclusions.find(i => i.onBus)?.onBus;
    }

    private get propMap(): PropertyTypeMap {
        const props = { ...this._properties };

        // import properties from included bindings:
        this._include.forEach(spec => {
            this.loader?.get(spec.name).forEach(type => {
                if (this._isChild) {
                    // If this is a child binding, we should be including bindings from the
                    // child binding of the included type. Our parent transferred our include
                    // spec to our tree before creating us.
                    type = type.child;
                    if (!type) {
                        return;
                    }
                }

                const filtered = filterProperties(type.propMap, spec);
                for (const name of filtered) {
                    props[name] = { ...type.propMap[name], ...(props[name] ?? {}) };
                }
            });
        });

        return props;
    }

    get properties(): PropertyType[] {
        return Object.values(this.propMap);
    }

    property(name: string) {
        return this.propMap[name];
    }

    get name() {
        return this.compatible;
    }
}

class AbstractNodeType extends NodeType {
    readonly valid: boolean = false;
}

export const standardProperties: PropertyTypeMap = {
    '#address-cells': {
        name: '#address-cells',
        required: false,
        type: 'int',
        description: `The #address-cells property defines the number of u32 cells used to encode the address field in a child node’s reg property.\n\nThe #address-cells and #size-cells properties are not inherited from ancestors in the devicetree. They shall be explicitly defined.\n\nA DTSpec-compliant boot program shall supply #address-cells and #size-cells on all nodes that have children. If missing, a client program should assume a default value of 2 for #address-cells, and a value of 1 for #size-cells`,
    },
    '#size-cells': {
        name: '#size-cells',
        required: false,
        type: 'int',
        description: `The #size-cells property defines the number of u32 cells used to encode the size field in a child node’s reg property.\n\nThe #address-cells and #size-cells properties are not inherited from ancestors in the devicetree. They shall be explicitly defined.\n\nA DTSpec-compliant boot program shall supply #address-cells and #size-cells on all nodes that have children. If missing, a client program should assume a default value of 2 for #address-cells, and a value of 1 for #size-cells`,
    },
    'model': {
        name: 'model',
        required: false,
        type: 'string',
        description: `The model property value is a string that specifies the manufacturer’s model number of the device. The recommended format is: "manufacturer,model", where manufacturer is a string describing the name of the manufacturer (such as a stock ticker symbol), and model specifies the model number.`,
    },
    'compatible': {
        name: 'compatible',
        required: false,
        type: 'string-array',
        description: `The compatible property value consists of one or more strings that define the specific programming model for the device. This list of strings should be used by a client program for device driver selection. The property value consists of a concatenated list of null terminated strings, from most specific to most general. They allow a device to express its compatibility with a family of similar devices, potentially allowing a single device driver to match against several devices.\n\nThe recommended format is "manufacturer,model", where manufacturer is a string describing the name of the manufacturer (such as a stock ticker symbol), and model the model number.`,
    },
    'phandle': {
        name: 'phandle',
        type: 'int',
        required: false,
        description: `The phandle property specifies a numerical identifier for a node that is unique within the devicetree. The phandle property value is used by other nodes that need to refer to the node associated with the property.`
    },
    'status': {
        name: 'status',
        type: 'string',
        required: false,
        enum: ['okay', 'disabled'],
        description: 'The status property indicates the operational status of a device.',
    },
    'clock-frequency': {
        name: 'clock-frequency',
        type: 'int',
        required: false,
        description: 'Specifies the frequency of a clock in Hz.'
    },
    'clocks': {
        name: 'clocks',
        type: 'phandle-array',
        required: false,
        description: 'Clock input to the device.'
    },
    'ranges': {
        name: 'ranges',
        type: ['boolean', 'array'],
        description: 'The ranges property provides a means of defining a mapping or translation between the address space of the\n' +
        'bus (the child address space) and the address space of the bus node’s parent (the parent address space).\n' +
        'The format of the value of the ranges property is an arbitrary number of triplets of (child-bus-address,\n' +
        'parentbus-address, length)\n' +
        '\n' +
        '- The child-bus-address is a physical address within the child bus’ address space. The number of cells to\n' +
        'represent the address is bus dependent and can be determined from the #address-cells of this node (the\n' +
        'node in which the ranges property appears).\n' +
        '- The parent-bus-address is a physical address within the parent bus’ address space. The number of cells\n' +
        'to represent the parent address is bus dependent and can be determined from the #address-cells property\n' +
        'of the node that defines the parent’s address space.\n' +
        '- The length specifies the size of the range in the child’s address space. The number of cells to represent\n' +
        'the size can be determined from the #size-cells of this node (the node in which the ranges property\n' +
        'appears).\n' +
        '\n' +
        'If the property is defined with an <empty> value, it specifies that the parent and child address space is\n' +
        'identical, and no address translation is required.\n' +
        'If the property is not present in a bus node, it is assumed that no mapping exists between children of the node\n' +
        'and the parent address space.\n',
        required: false
    },
    'reg-shift': {
        name: 'reg-shift',
        type: 'int',
        required: false,
        description: 'The reg-shift property provides a mechanism to represent devices that are identical in most\n' +
        'respects except for the number of bytes between registers. The reg-shift property specifies in bytes\n' +
        'how far the discrete device registers are separated from each other. The individual register location\n' +
        'is calculated by using following formula: “registers address” << reg-shift. If unspecified, the default\n' +
        'value is 0.\n' +
        'For example, in a system where 16540 UART registers are located at addresses 0x0, 0x4, 0x8, 0xC,\n' +
        '0x10, 0x14, 0x18, and 0x1C, a reg-shift = 2 property would be used to specify register\n' +
        'locations.`\n',
    },
    'label': {
        name: 'label',
        type: 'string',
        required: false,
        description: 'The label property defines a human readable string describing a device. The binding for a given device specifies the exact meaning of the property for that device.'
    },
    'reg': {
        name: 'reg',
        type: 'array',
        required: false,
        description: 'The reg property describes the address of the device’s resources within the address space defined by its parent\n' +
        'bus. Most commonly this means the offsets and lengths of memory-mapped IO register blocks, but may have\n' +
        'a different meaning on some bus types. Addresses in the address space defined by the root node are CPU real\n' +
        'addresses.\n' +
        '\n' +
        'The value is a prop-encoded-array, composed of an arbitrary number of pairs of address and length,\n' +
        'address length. The number of u32 cells required to specify the address and length are bus-specific\n' +
        'and are specified by the #address-cells and #size-cells properties in the parent of the device node. If the parent\n' +
        'node specifies a value of 0 for #size-cells, the length field in the value of reg shall be omitted.\n',
    }
};

const standardTypes = [
    new NodeType({
        name: '/',
        description: 'The devicetree has a single root node of which all other device nodes are descendants. The full path to the root node is /.',
        properties: {
            '#address-cells': {
                required: true,
                description: 'Specifies the number of <u32> cells to represent the address in the reg property in children of root',
            },
            '#size-cells': {
                required: true,
                description: 'Specifies the number of <u32> cells to represent the size in the reg property in children of root.',
            },
            'model': {
                required: true,
                description: 'Specifies a string that uniquely identifies the model of the system board. The recommended format is `"manufacturer,model-number".`',
            },
            'compatible': {
                required: true,
                description: 'Specifies a list of platform architectures with which this platform is compatible. This property can be used by operating systems in selecting platform specific code. The recommended form of the property value is:\n"manufacturer,model"\nFor example:\ncompatible = "fsl,mpc8572ds"',
            },
        },
        title: 'Root node'
    }),
    new AbstractNodeType({
        name: 'simple-bus',
        title: 'Internal I/O bus',
        description: 'System-on-a-chip processors may have an internal I/O bus that cannot be probed for devices. The devices on the bus can be accessed directly without additional configuration required. This type of bus is represented as a node with a compatible value of “simple-bus”.',
        properties: {
            'compatible': {
                required: true,
            },
            'ranges': {
                required: true,
            },
        }
    }),
    new NodeType({
        name: '/cpus/',
        title: '/cpus',
        description: `A /cpus node is required for all devicetrees. It does not represent a real device in the system, but acts as a container for child cpu nodes which represent the systems CPUs.`,
        properties: {
            '#address-cells': {
                required: true,
            },
            '#size-cells': {
                required: true,
            }
        }
    }),
    new NodeType({
        name: '/cpus/cpu',
        title: 'CPU instance',
        description: 'A cpu node represents a hardware execution block that is sufficiently independent that it is capable of running an operating\n' +
        'system without interfering with other CPUs possibly running other operating systems.\n' +
        'Hardware threads that share an MMU would generally be represented under one cpu node. If other more complex CPU\n' +
        'topographies are designed, the binding for the CPU must describe the topography (e.g. threads that don’t share an MMU).\n' +
        'CPUs and threads are numbered through a unified number-space that should match as closely as possible the interrupt\n' +
        'controller’s numbering of CPUs/threads.\n' +
        '\n' +
        'Properties that have identical values across cpu nodes may be placed in the /cpus node instead. A client program must\n' +
        'first examine a specific cpu node, but if an expected property is not found then it should look at the parent /cpus node.\n' +
        'This results in a less verbose representation of properties which are identical across all CPUs.\n' +
        'The node name for every CPU node should be cpu.`\n',
        properties: {
            'device_type': {
                name: 'device_type',
                type: 'string',
                const: 'cpu',
                description: `Value shall be "cpu"`,
                required: true,
            },
            'reg': {
                type: ['int', 'array'],
                description: `The value of reg is a <prop-encoded-array> that defines a unique CPU/thread id for the CPU/threads represented by the CPU node. If a CPU supports more than one thread (i.e. multiple streams of execution) the reg property is an array with 1 element per thread. The #address-cells on the /cpus node specifies how many cells each element of the array takes. Software can determine the number of threads by dividing the size of reg by the parent node’s #address-cells. If a CPU/thread can be the target of an external interrupt the reg property value must be a unique CPU/thread id that is addressable by the interrupt controller. If a CPU/thread cannot be the target of an external interrupt, then reg must be unique and out of bounds of the range addressed by the interrupt controller. If a CPU/thread’s PIR (pending interrupt register) is modifiable, a client program should modify PIR to match the reg property value. If PIR cannot be modified and the PIR value is distinct from the interrupt controller number space, the CPUs binding may define a binding-specific representation of PIR values if desired.`,
                required: true
            }
        }
    }),
    new NodeType({
        name: '/chosen/',
        title: '/Chosen node',
        description: `The /chosen node does not represent a real device in the system but describes parameters chosen or specified by the system firmware at run time. It shall be a child of the root node`,
        properties: {
            'zephyr,flash': {
                name: 'zephyr,flash',
                type: 'phandle',
                required: false,
                description: 'Generates symbol CONFIG_FLASH'
            },
            'zephyr,sram': {
                name: 'zephyr,sram',
                type: 'phandle',
                required: false,
                description: 'Generates symbol CONFIG_SRAM_SIZE/CONFIG_SRAM_BASE_ADDRESS (via DT_SRAM_SIZE/DT_SRAM_BASE_ADDRESS)'
            },
            'zephyr,ccm': {
                name: 'zephyr,ccm',
                type: 'phandle',
                required: false,
                description: 'Generates symbol DT_CCM'
            },
            'zephyr,console': {
                name: 'zephyr,console',
                type: 'phandle',
                required: false,
                description: 'Generates symbol DT_UART_CONSOLE_ON_DEV_NAME'
            },
            'zephyr,shell-uart': {
                name: 'zephyr,shell-uart',
                type: 'phandle',
                required: false,
                description: 'Generates symbol DT_UART_SHELL_ON_DEV_NAME'
            },
            'zephyr,bt-uart': {
                name: 'zephyr,bt-uart',
                type: 'phandle',
                required: false,
                description: 'Generates symbol DT_BT_UART_ON_DEV_NAME'
            },
            'zephyr,uart-pipe': {
                name: 'zephyr,uart-pipe',
                type: 'phandle',
                required: false,
                description: 'Generates symbol DT_UART_PIPE_ON_DEV_NAME'
            },
            'zephyr,bt-mon-uart': {
                name: 'zephyr,bt-mon-uart',
                type: 'phandle',
                required: false,
                description: 'Generates symbol DT_BT_MONITOR_ON_DEV_NAME'
            },
            'zephyr,uart-mcumgr': {
                name: 'zephyr,uart-mcumgr',
                type: 'phandle',
                required: false,
                description: 'Generates symbol DT_UART_MCUMGR_ON_DEV_NAME'
            },
        }
    }),
    new NodeType({
        name: '/aliases/',
        title: 'Aliases',
        description: `A devicetree may have an aliases node (/aliases) that defines one or more alias properties. The alias node shall be at the root of the devicetree and have the node name /aliases. Each property of the /aliases node defines an alias. The property name specifies the alias name. The property value specifies the full path to a node in the devicetree. For example, the property serial0 = "/simple-bus@fe000000/ serial@llc500" defines the alias serial0. Alias names shall be a lowercase text strings of 1 to 31 characters from the following set of characters.\n\nAn alias value is a device path and is encoded as a string. The value represents the full path to a node, but the path does not need to refer to a leaf node. A client program may use an alias property name to refer to a full device path as all or part of its string value. A client program, when considering a string as a device path, shall detect and use the alias.`,
    }),
    new NodeType({
        name: '/zephyr,user/',
        title: 'User defined properties',
        description: `Convenience node for application specific properties. Properties in /zephyr,user/ don't need a devicetree binding, and can be used for any purpose. The type of the properties in the /zephyr,user node will be inferred from their value.`,
    }),
];

export class TypeLoader {
    types: {[name: string]: NodeType[]};
    folders: string[] = []
    diags: vscode.DiagnosticCollection;
    baseType: NodeType;

    constructor() {
        this.diags = vscode.languages.createDiagnosticCollection('DeviceTree types');
        this.baseType = new AbstractNodeType({ name: '<unknown>', properties: { ...standardProperties } });
        this.types = {};
        standardTypes.forEach(type => this.addType(type));
    }

    private addType(type: NodeType) {
        if (type.name in this.types) {
            this.types[type.name].push(type);
        } else {
            this.types[type.name] = [type];
        }

        type.setLoader(this);
    }

    async addFolder(folder: string) {
        this.folders.push(folder);
        const g = glob.sync('**/*.yaml', { cwd: folder, ignore: 'test/*' });
        return Promise.all(g.map(file => new Promise<void>(resolve => {
            const filePath = path.resolve(folder, file);
            readFile(filePath, 'utf-8', async (err, out) => {
                if (err) {
                    console.log(`Couldn't open ${file}`);
                } else {
                    try {
                        let tree = yaml.load(out, { json: true });
                        this.addType(new NodeType({ name: path.basename(file, '.yaml'), ...tree }, filePath));
                    } catch (e) {
                        // TODO: handle this
                        console.log(e);
                    }
                }

                resolve();
            });
        })));
    }

    get(name: string): NodeType[] {
        if (!(name in this.types)) {
            return [];
        }

        return this.types[name];
    }

    nodeType(node: Node): NodeType {
        const props = node.uniqueProperties();

        const getBaseType = () => {
            const candidates = [node.path];

            const compatibleProp = props.find(p => p.name === 'compatible');
            if (compatibleProp) {
                const compatible = compatibleProp.stringArray;
                if (compatible) {
                    candidates.push(...compatible);
                }
            }

            candidates.push(node.name);
            candidates.push(node.name.replace(/s$/, ''));

            if (node.path.match(/\/cpus\/cpu[^/]*\/$/)) {
                candidates.push('/cpus/cpu');
            }

            let types: NodeType[];
            if (candidates.some(c => (types = this.get(c)).length)) {
                return types;
            }

            if (node.parent?.type?.child) {
                return [node.parent.type.child];
            }

            return [];
        };

        let types = getBaseType();

        if (!types.length) {
            types = [this.baseType];
        }

        if (node.parent?.type && types.length > 1) {
            return types.find(t => node.parent.type.bus === t.onBus) ?? types[0];
        }

        return types[0];
    }
}
