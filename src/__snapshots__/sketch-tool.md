# sketch

Draws an architecture diagram. You give the topology, what exists and what talks to what; excalix picks every shape, colour, size and route, so there is nothing visual to configure. Alongside the PNG you get back, an .excalidraw file lands on disk that opens on excalidraw.com for hand editing.

Node kinds:
client: people, browsers, mobile apps, anything that initiates requests.
service: an application component you run.
datastore: database or durable storage.
queue: message queue, topic, or stream.
cache: cache or in-memory store.
external: third-party system you don't run.

Edge styles:
sync: request/response, solid arrow.
async: message or event, dashed arrow.

List nodes in reading order, sources first: siblings keep the order you write them in as far as the routing allows. Keep edge labels to a few words, because an edge label sits on its arrow and reserves that much width. A \n in any label starts a new line.

Look at the returned image and call again with an adjusted spec if labels overlap or the flow reads wrong.

## inputSchema

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "heading drawn above the diagram"
    },
    "direction": {
      "default": "lr",
      "description": "which way the diagram flows",
      "anyOf": [
        {
          "type": "string",
          "const": "lr",
          "description": "left to right"
        },
        {
          "type": "string",
          "const": "tb",
          "description": "top to bottom"
        }
      ]
    },
    "groups": {
      "default": [],
      "description": "boundaries, nestable through parent",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]+$",
            "description": "unique id, referenced by node.group and group.parent"
          },
          "label": {
            "type": "string",
            "description": "text drawn inside the top-left corner of the box"
          },
          "parent": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]+$",
            "description": "id of the group this one nests inside"
          }
        },
        "required": [
          "id",
          "label"
        ],
        "additionalProperties": false,
        "description": "a dashed boundary drawn around nodes, such as a VPC, cluster, or account"
      }
    },
    "nodes": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]+$",
            "description": "unique id, referenced by edge.from, edge.to and group membership"
          },
          "label": {
            "type": "string",
            "description": "text drawn inside the box; a \\n starts a new line"
          },
          "kind": {
            "anyOf": [
              {
                "type": "string",
                "const": "client",
                "description": "people, browsers, mobile apps, anything that initiates requests"
              },
              {
                "type": "string",
                "const": "service",
                "description": "an application component you run"
              },
              {
                "type": "string",
                "const": "datastore",
                "description": "database or durable storage"
              },
              {
                "type": "string",
                "const": "queue",
                "description": "message queue, topic, or stream"
              },
              {
                "type": "string",
                "const": "cache",
                "description": "cache or in-memory store"
              },
              {
                "type": "string",
                "const": "external",
                "description": "third-party system you don't run"
              }
            ],
            "description": "what the node is; fixes its shape and colour"
          },
          "group": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]+$",
            "description": "id of the group this node sits inside"
          }
        },
        "required": [
          "id",
          "label",
          "kind"
        ],
        "additionalProperties": false,
        "description": "one box in the diagram"
      },
      "description": "every box in the diagram, in reading order"
    },
    "edges": {
      "default": [],
      "description": "every arrow in the diagram",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]+$",
            "description": "id of the node the arrow leaves"
          },
          "to": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]+$",
            "description": "id of the node the arrow points at"
          },
          "label": {
            "type": "string",
            "description": "text drawn on the arrow, a few words at most: the arrow reserves the width"
          },
          "style": {
            "default": "sync",
            "description": "how the two ends talk",
            "anyOf": [
              {
                "type": "string",
                "const": "sync",
                "description": "request/response, solid arrow"
              },
              {
                "type": "string",
                "const": "async",
                "description": "message or event, dashed arrow"
              }
            ]
          },
          "arrows": {
            "default": "forward",
            "description": "which ends of the arrow get an arrowhead",
            "anyOf": [
              {
                "type": "string",
                "const": "forward",
                "description": "one arrowhead, at the target"
              },
              {
                "type": "string",
                "const": "both",
                "description": "an arrowhead at each end, for a bidirectional link"
              },
              {
                "type": "string",
                "const": "none",
                "description": "no arrowhead, a plain association"
              }
            ]
          }
        },
        "required": [
          "from",
          "to"
        ],
        "additionalProperties": false,
        "description": "an arrow between two nodes; self edges and repeated pairs are allowed"
      }
    },
    "out": {
      "description": "output basename without extension; writes <out>.excalidraw, <out>.svg and <out>.png. Relative paths resolve against the server's working directory, which is the project directory when Claude Code launches the server. Defaults to diagrams/<title slug>.",
      "type": "string"
    }
  },
  "required": [
    "nodes"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false,
  "description": "an architecture topology: what exists and what talks to what"
}
```

## outputSchema

```json
{
  "type": "object",
  "properties": {
    "excalidraw": {
      "type": "string",
      "description": "the .excalidraw file, the one to open on excalidraw.com"
    },
    "svg": {
      "type": "string",
      "description": "the .svg file"
    },
    "png": {
      "type": "string",
      "description": "the .png file, the same image as the image block in this result"
    },
    "pixels": {
      "type": "object",
      "properties": {
        "width": {
          "type": "number"
        },
        "height": {
          "type": "number"
        }
      },
      "required": [
        "width",
        "height"
      ],
      "additionalProperties": false,
      "description": "size of that png; a very wide one usually means a long label stretched the layout"
    }
  },
  "required": [
    "excalidraw",
    "svg",
    "png",
    "pixels"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false
}
```

## execution

```json
{
  "taskSupport": "forbidden"
}
```
