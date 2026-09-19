# sketch

Draws an architecture diagram. You give the topology, what exists and what talks to what; excalix picks every shape, colour, size and route, so there is nothing visual to configure.

Node kinds:
client: people, browsers, mobile apps, anything that initiates requests.
service: an application component you run, or managed infrastructure you configure inside your own boundary: load balancer, CDN, API gateway, DNS.
datastore: database or durable storage.
queue: message queue, topic, or stream.
cache: cache or in-memory store.
external: a system another company operates and you only call, such as a payment API or a hosted identity provider.

Edge styles:
sync: request/response, solid arrow.
async: message or event, dashed arrow.

A node sits in exactly one group: name the group it runs in, and let an edge across the boundary carry any other relationship.

List nodes in reading order, sources first. That is all order does: place siblings beside each other. It never steers where an arrow is routed; what moves a layout is the direction of an edge, which nodes share a group, and direction itself.

Keep edge labels to a few words, because an edge label sits on its arrow and reserves that much width. A \n in any label starts a new line. Keep one diagram to roughly twenty nodes, fewer if they run in a single chain: past that the image comes back large enough that the copy you see is scaled down below reading, and the answer is two diagrams, an overview and a detail. Long chains suit lr, deep hierarchies tb.

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
        "description": "a boundary drawn around nodes, such as a VPC, cluster, or account"
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
                "description": "an application component you run, or managed infrastructure you configure inside your own boundary: load balancer, CDN, API gateway, DNS"
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
                "description": "a system another company operates and you only call, such as a payment API or a hosted identity provider"
              }
            ],
            "description": "what the node is; fixes its shape and colour"
          },
          "group": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]+$",
            "description": "id of the group this node sits inside, exactly one: name the group it runs in and let an edge across the boundary carry any other relationship"
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
