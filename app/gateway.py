# Shared Bank Gateway Health Status & Simulation Overrides

GATEWAY_HEALTH = {
    "HDFC": "stable",
    "ICICI": "stable",
    "SBI": "stable",
    "UPI": "stable"
}

# Active Simulation Override state
# Supported values: 'normal', 'induce_gateway_failure', 'customer_opt_out', 'dispute_trigger'
SIMULATION_OVERRIDE = "normal"
