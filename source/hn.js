// Experimental

var hn = hn || {};
var json = json || require('./json');

hn.DataTypes = {
    STRING: 'string',
    BOOLEAN: 'boolean',
    NUMBER: 'number',
    ARRAY: 'array'
};

hn.MetadataFile = 'hn-metadata.json';

hn.ModelFactory = class {
    match(context) {
        const extension = context.identifier.split('.').pop().toLowerCase();
        if (extension === 'hn') {
            const obj = context.open('json');
            if (obj && obj.name && obj.net_params && obj.layers) {
                return 'model.hn';
            }
        }
        return undefined;
    }

    open(context, match) {
        return context.metadata(hn.MetadataFile).then((metadata) => {
            switch (match) {
                case 'model.hn': {
                    const configuration = context.open('json');
                    const graph_metadata = new hn.GraphMetadata(metadata);

                    return new hn.Model(graph_metadata, configuration);
                }

                default: {
                    throw new hn.Error("Unsupported Hailo Network format '" + match + "'.");
                }
            }
        });
    }
};

hn.Model = class {
    constructor(metadata, configuration) {
        this._graphs = [];
        this._graphs.push(new hn.Graph(metadata, configuration));
        this._name = configuration && configuration.name || "";
        this._version = configuration && configuration.net_params && configuration.net_params.version || 0.0;
        this._format = 'hn';
    }

    get graphs() {
        return this._graphs;
    }

    get format() {
        return this._format;
    }

    get name() {
        return this._name;
    }

    get version() {
        return this._version;
    }
};

hn.GraphMetadata = class {
    constructor(metadata) {
        this._metadata = metadata;
        this._types = new Map();
    }

    type(name) {
        if (this._types.has(name)) {
            return this._types.get(name);
        }
        return this._metadata.type(name);
    }

    attribute(type, name) {
        return this._metadata.attribute(type, name);
    }

    add(type, metadata) {
        this._types.set(type, metadata);
    }
};

hn.Graph = class {
    constructor(metadata, configuration) {
        this._inputs = [];
        this._outputs = [];
        this._attributes = [];

        const mapLayersObjectToArray = (layers_object = {}) => {
            const entries = Object.entries(layers_object);
            return entries.map(([layer_name, layer_object]) => {
                layer_object.name = layer_name;
                return layer_object;
            });
        };

        const getNodes = (layers = []) => {
            return layers.map((layer) => {
                const {type} = layer;
                const layer_metadata = metadata.type(type);
                return new hn.Node(layer_metadata, layer);
            });
        };


        const layers = mapLayersObjectToArray(configuration.layers);

        this._nodes = configuration && configuration.layers && getNodes(layers);
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }
};

hn.Parameter = class {
    constructor(name, visible, args) {
        this._name = name;
        this._visible = visible;
        this._arguments = args;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return this._visible;
    }

    get arguments() {
        return this._arguments;
    }
};

hn.Argument = class {
    constructor(name, type, initializer) {
        if (typeof name !== hn.DataTypes.STRING) {
            throw new hn.Error("Invalid argument identifier '" + JSON.stringify(name) + "'.");
        }
        this._name = name;
        this._type = type;
        this._initializer = initializer;
    }

    get name() {
        return this._name;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
};

hn.Node = class {
    constructor(layer_metadata, layer) {

        const getTypeByName = ((layer_metadata) => (attribute_name) => {
            return layer_metadata && layer_metadata.attributes && layer_metadata.attributes.find(({name}) => {
                return name === attribute_name
            }) || {
                name,
                type: "Layer",
                visible: true
            }
        })(layer_metadata)

        const getNodeAttributes = (layer) => {
            const {
                original_names,
                compilation_params,
                quantization_params,
                defuse_params,
            } = layer;

            const params_object = {
                ...compilation_params,
                ...quantization_params,
                ...defuse_params,
            };

            if (original_names) {
                params_object.original_names = original_names;
            }

            return Object.entries(params_object).reduce((acc, [name, value]) => {
                const schema = getTypeByName(name)
                const attribute = new hn.Attribute(schema, name, value)
                acc.push(attribute);
                return acc;
            }, []);
        };

        const getNodeInputs = ({input, input_shapes: [input_shape] = [], params}) => {
            const input_shapes = input.map((input_layer) => {
                return new hn.Parameter(input_layer, true, [
                    new hn.Argument(input_layer, `${hn.DataTypes.ARRAY}[${input_shape}]`)
                ]);
            });

            const getParams = (params_array) => {
                return params_array.reduce((acc, [name, value]) => {
                    const schema = getTypeByName(name);
                    if (schema.visible) {
                        if (!Array.isArray(value)) {
                            value = [value]
                        }
                        acc.push(new hn.Parameter(name, true, [
                            new hn.Argument(name, null, new hn.Tensor(hn.DataTypes.ARRAY, value), value)
                        ]));
                    }
                    return acc;
                }, [])
            }

            const params_array = params ? Object.entries(params) : [];
            const params_list = getParams(params_array, layer_metadata);

            return input_shapes.concat(params_list);
        };

        const getNodeOutputs = ({name, output = [], output_shapes: [output_shape] = []}) => {
            return output.map((output_layer) => {
                const slice = output_shape.slice(1, output_shape.length);
                return new hn.Parameter(output_layer, true, [
                    new hn.Argument(name, new hn.TensorType(hn.DataTypes.ARRAY, new hn.TensorShape(slice)))
                ]);
            });
        };

        const getChain = (layer) => {
            return layer && layer.params && layer.params.activation ? [new hn.Node({name: "activation", type: "Activation", visible: true}, {
                type: "Activation",
                name: layer.params.activation,
                input: [],
                output: []
            })] : []
        };


        this._name = layer.name || '';
        this._type = { category: layer_metadata.type, name: layer.name, attributes: layer_metadata.attributes };

        this._inputs = getNodeInputs(layer);
        this._outputs = getNodeOutputs(layer);
        this._attributes = getNodeAttributes(layer);
        this._chain = getChain(layer);
    }

    get type() {
        return this._type;
    }

    get name() {
        return this._name;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get attributes() {
        return this._attributes;
    }

    get chain() {
        return this._chain;
    }
};

hn.Attribute = class {
    constructor(schema, name, value) {
        this._name = name;
        this._value = value;
        if (schema) {
            this._type = schema.type || '';
            this._visible = schema.visible || true;
        }
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible !== false;
    }
};

hn.Tensor = class {
    constructor(dataType, shape) {
        this._type = new hn.TensorType(dataType, new hn.TensorShape(shape));
    }

    get type() {
        return this._type;
    }

    get state() {
        return 'Tensor data not implemented.';
    }
};

hn.TensorType = class {
    constructor(dataType, shape) {
        this._dataType = dataType;
        this._shape = shape;
    }

    get dataType() {
        return this._dataType;
    }

    get shape() {
        return this._shape;
    }

    toString() {
        return (this.dataType || '?') + this._shape.toString();
    }
};

hn.TensorShape = class {
    constructor(dimensions) {
        this._dimensions = dimensions;
    }

    get dimensions() {
        return this._dimensions;
    }

    toString() {
        if (this._dimensions) {
            if (this._dimensions.length === 0) {
                return '';
            }
            return '[' + this._dimensions.map((dimension) => dimension.toString()).join(',') + ']';
        }
        return '';
    }
};


hn.Error = class extends Error {
    constructor(message) {
        super(message);
        this.name = 'Error loading HN model.';
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = hn.ModelFactory;
}
