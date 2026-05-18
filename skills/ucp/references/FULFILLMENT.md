# Fulfillment and line items

Use this when composing cart or checkout updates that involve shipping, pickup, or quantities.

## Mental model

Fulfillment has three levels of certainty:

1. **`context` = hints** — localization, currency, ranking, and availability signals. Do not treat `context.postal_code` as shipping calculation.
2. **Cart = basket + optional estimates** — if `cart update --input-schema` accepts `fulfillment.methods[].destinations[]`, cart updates can return merchant-provided shipping/fulfillment estimates.
3. **Checkout = final/selectable fulfillment** — checkout update is the authoritative surface for the merchant-returned `methods[]` list: shipping, pickup, method-specific destinations, groups, selected option ids, final pre-completion totals, and buyer-review/escalation states.

## Request-shaped `line_items`

Cart and checkout updates are full-replace: resend the full request-shaped `line_items` array on every update. Do not paste enriched response line items with titles, prices, images, totals, or other response-only fields unless the live `--input-schema` advertises them.

Existing line:

```json
{
  "id": "<line_item_id>",
  "item": { "id": "<item_id>" },
  "quantity": 1
}
```

Net-new line:

```json
{
  "item": { "id": "<item_id>" },
  "quantity": 1
}
```

- `line_items[].id` targets an existing cart/checkout line.
- `line_items[].item.id` identifies the underlying item or variant.
- Net-new create lines do not have line ids yet; do not invent them.
- For updates, derive `line_items` from the cart/checkout response you are updating, not from the original catalog result; merchants may normalize item ids after cart creation.

## Cart-stage estimate

When the buyer asks for shipping cost before checkout:

```sh
ucp cart update --input-schema --business https://<seller-domain>
```

If the schema accepts fulfillment destinations, send a destination with request-shaped line items:

```sh
ucp cart update <cart_id> --business https://<seller-domain> --input '{
  "line_items": [
    {"id":"<line_item_id>","item":{"id":"<item_id>"},"quantity":1}
  ],
  "fulfillment": {
    "methods": [{
      "type": "shipping",
      "line_item_ids": ["<line_item_id>"],
      "destinations": [{
        "address_country": "US",
        "address_region": "CA",
        "postal_code": "94105"
      }]
    }]
  }
}'
```

Treat cart fulfillment/totals as estimates or quote previews. If the update succeeds but returns no `fulfillment.methods[]` or options, report that the merchant did not provide a cart-stage estimate for that destination; do not infer free shipping or no shipping. Use checkout for final selectable options.

## Checkout fulfillment

First inspect the live schema:

```sh
ucp checkout update --input-schema --business https://<seller-domain>
```

Fulfillment is method-agnostic. The business returns `fulfillment.methods[]`; present all returned methods to the buyer unless the buyer already chose one. Do not hide pickup just because shipping is easy to automate, and do not silently choose a method or option when multiple buyer-meaningful choices are available. A method can be `shipping`, `pickup`, or a future extension. Each method owns the line ids it fulfills, its destinations, and its option groups.

For shipping, provide the buyer address as a destination:

```sh
ucp checkout update <checkout_id> --business https://<seller-domain> --input '{
  "line_items": [
    {"id":"<line_item_id>","item":{"id":"<item_id>"},"quantity":1}
  ],
  "fulfillment": {
    "methods": [{
      "type": "shipping",
      "line_item_ids": ["<line_item_id>"],
      "destinations": [{
        "first_name": "<first_name>",
        "last_name": "<last_name>",
        "street_address": "<street_address>",
        "address_locality": "<city>",
        "address_region": "<region>",
        "postal_code": "<postal_code>",
        "address_country": "<country>"
      }]
    }]
  }
}'
```

For pickup, the merchant usually returns retail-location destinations. Present those destinations, then send the chosen destination id back as `selected_destination_id`:

```json
{
  "line_items": [
    {"id":"<line_item_id>","item":{"id":"<item_id>"},"quantity":1}
  ],
  "fulfillment": {
    "methods": [{
      "type": "pickup",
      "line_item_ids": ["<line_item_id>"],
      "selected_destination_id": "<pickup_destination_id>"
    }]
  }
}
```

When the response returns `fulfillment.methods[].groups[].options[]`, present the returned options to the buyer unless they already gave a clear preference such as cheapest, fastest, pickup, or a specific store. After the buyer chooses, select an option per group:

```json
{
  "line_items": [
    {"id":"<line_item_id>","item":{"id":"<item_id>"},"quantity":1}
  ],
  "fulfillment": {
    "methods": [{
      "type": "shipping",
      "line_item_ids": ["<line_item_id>"],
      "groups": [{
        "id": "<group_id>",
        "selected_option_id": "<option_id>"
      }]
    }]
  }
}
```

## Pitfalls

- Do not send `line_item_ids: []`; include real `result.line_items[N].id` values.
- Do not use `delivery_groups` or `delivery_option_handle`; UCP fulfillment uses `fulfillment.methods[]`.
- Do not assume shipping is the only method; present all merchant-returned `fulfillment.methods[]` unless the buyer already chose a method.
- Do not silently pick between buyer-meaningful methods, destinations, or options; ask or confirm unless the buyer's preference is already clear.
- Do not rely on cart estimates as final checkout options.
- Do not confuse `<cart_id>` / `<checkout_id>` resource ids with `<line_item_id>` line ids or `<item_id>` variant ids.
