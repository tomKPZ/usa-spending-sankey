"use strict";

const axios = require("axios");
const d3_node = require("d3-node");
const d3_sankey = require("d3-sankey");
const d3_shape = require("d3-shape");
const fs = require("fs");

const YEAR = "2019";
const PADDING = 5;
const NODE_THICKNESS = 25;
const WIDTH = 2560;
const HEIGHT = 1440;
const ENDPOINT = "https://api.usaspending.gov/api/v2/spending/";

var categories = {};
var amounts = [];

async function download_categories() {
  var requests = [];
  for (const category of ["object_class", "budget_function", "agency"]) {
    requests.push(
      axios.post(ENDPOINT, {
        type: category,
        filters: { fy: YEAR }
      })
    );
    categories[category] = [];
  }
  for (const request of requests) {
    const response = await request;
    for (var result of response.data.results) {
      if (result.amount != 0) {
        categories[result.type].push([result.id, result.name]);
      }
    }
  }
}

async function download_amounts() {
  var requests = [];
  for (const object_class of categories.object_class) {
    for (const budget_function of categories.budget_function) {
      requests.push({
        object_class,
        budget_function,
        request: axios.post(ENDPOINT, {
          type: "agency",
          filters: {
            fy: YEAR,
            object_class: object_class[0],
            budget_function: budget_function[0]
          }
        })
      });
    }
  }
  for (const request of requests) {
    const response = await request.request;
    for (var result of response.data.results) {
      amounts.push({
        object_class: request.object_class[1],
        budget_function: request.budget_function[1],
        agency: result.name,
        amount: result.amount
      });
    }
  }
}

function remove_ids(list) {
  for (var i = 0; i < list.length; i += 1) {
    list[i] = list[i][1];
  }
}

function consolidate_agencies(n_agencies) {
  for (var amount of amounts) {
    if (categories.agency.indexOf(amount.agency) >= n_agencies) {
      amount.agency = "Other";
    }
  }
  categories.agency.splice(n_agencies);
  categories.agency.push("Other");
}

function create_graph() {
  var nodes = [];
  var links = [];
  nodes.push({ name: "USA FY " + YEAR + " Spending" });
  function gen_ids(categories) {
    var ids = {};
    for (const category of categories) {
      ids[category] = nodes.length;
      nodes.push({ name: category });
    }
    return ids;
  }
  const object_class_ids = gen_ids(categories.object_class);
  const budget_function_ids = gen_ids(categories.budget_function);
  const agency_ids = gen_ids(categories.agency);

  function sum_filter(constraints) {
    var total = 0;
    loop: for (const amount of amounts) {
      for (const key in constraints) {
        if (amount[key] != constraints[key]) {
          continue loop;
        }
      }
      total += amount.amount;
    }
    return total;
  }

  for (const object_class of categories.object_class) {
    links.push({
      source: 0,
      target: object_class_ids[object_class],
      names: [object_class],
      value: sum_filter({ object_class })
    });
    for (const budget_function of categories.budget_function) {
      const total = sum_filter({ object_class, budget_function });
      if (total > 0) {
        links.push({
          source: object_class_ids[object_class],
          target: budget_function_ids[budget_function],
          names: [object_class, budget_function],
          value: total
        });
      }
      for (const agency of categories.agency) {
        const total = sum_filter({ object_class, budget_function, agency });
        if (total > 0) {
          links.push({
            source: budget_function_ids[budget_function],
            target: agency_ids[agency],
            names: [object_class, budget_function, agency],
            value: total
          });
        }
      }
    }
  }
  return { nodes, links };
}

function justify_vertically(nodes) {
  for (var layer = 0; layer < 4; layer++) {
    var layer_nodes = [];
    var node_height = 0;
    for (var node of nodes) {
      if (node.layer == layer) {
        layer_nodes.push(node);
        node_height += node.y1 - node.y0;
      }
    }
    var spacing = (HEIGHT - node_height) / (layer_nodes.length + 1);
    var y = spacing;
    for (var node of layer_nodes) {
      var offset = y - node.y0;
      y += node.y1 - node.y0;
      y += spacing;
      node.y0 += offset;
      node.y1 += offset;
      for (var link of node.sourceLinks) {
        link.y0 += offset;
      }
      for (var link of node.targetLinks) {
        link.y1 += offset;
      }
    }
  }
}

function color(node) {
  return ["#4285f4", "#db4437", "#f4b400", "#0f9d58", "#ff6d00", "#ab30c4"][
    categories.object_class.indexOf(node.names[0])
  ];
}

const format_currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
}).format;

function draw_svg(svg, nodes, links) {
  svg
    .append("g")
    .attr("fill", "none")
    .selectAll("g")
    .data(links)
    .join("path")
    .attr("d", d3_sankey.sankeyLinkHorizontal())
    .attr("stroke", d => color(d) + "a0")
    .attr("stroke-width", d => d.width)
    .style("mix-blend-mode", "multiply")
    .append("title")
    .text(d => `${d.names.join(" → ")}\n${format_currency(d.value)}`);

  function draw_nodes(links, shaper) {
    svg
      .append("g")
      .attr("fill", "none")
      .selectAll("g")
      .data(links)
      .join("path")
      .attr("d", shaper)
      .attr("stroke", color)
      .attr("stroke-width", d => d.width);
  }
  draw_nodes(
    links,
    d3_shape
      .linkHorizontal()
      .source(d => [d.target.x0 - 1, d.y1])
      .target(d => [d.target.x0 + NODE_THICKNESS + 1, d.y1])
  );
  draw_nodes(
    nodes[0].sourceLinks,
    d3_shape
      .linkHorizontal()
      .source(d => [d.source.x0 - 1, d.y0])
      .target(d => [d.source.x0 + NODE_THICKNESS + 1, d.y0])
  );

  svg
    .append("g")
    .style("font-family", "sans-serif")
    .style("font-weight", "bold")
    .selectAll("text")
    .data(nodes)
    .join("text")
    .attr("x", d => (d.x0 < WIDTH / 2 ? d.x1 + 6 : d.x0 - 6))
    .attr("y", d => (d.y1 + d.y0) / 2)
    .attr("dy", "0.35em")
    .attr("text-anchor", d => (d.x0 < WIDTH / 2 ? "start" : "end"))
    .text(d => d.name)
    .append("tspan")
    .attr("fill-opacity", 0.85)
    .text(d => ` ${format_currency(d.value)}`);
}

function visualize() {
  var graph = d3_sankey
    .sankey()
    .nodeSort(null)
    .linkSort(null)
    .nodeWidth(NODE_THICKNESS)
    .nodePadding(15)
    .extent([
      [PADDING, PADDING],
      [WIDTH - PADDING, HEIGHT - PADDING]
    ])(create_graph());

  justify_vertically(graph.nodes);

  var d3n = new d3_node();
  const svg = d3n.createSVG(WIDTH, HEIGHT);
  draw_svg(svg, graph.nodes, graph.links);
  fs.writeFileSync("graph.svg", d3n.svgString());
}

function clean_data() {
  for (var key in categories) {
    remove_ids(categories[key]);
  }

  consolidate_agencies(18);
}

async function main() {
  await download_categories();
  await download_amounts();
  clean_data();
  visualize();
}

main();
