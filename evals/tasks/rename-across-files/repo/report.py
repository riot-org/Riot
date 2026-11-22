import utils

def summary(orders):
    return {name: utils.calc_total(items) for name, items in orders.items()}
