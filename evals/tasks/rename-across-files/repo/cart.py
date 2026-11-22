from utils import calc_total

def checkout(items, discount=0):
    return calc_total(items) - discount
