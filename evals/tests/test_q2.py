import numpy as np

from sift_evals.run_q2 import grouping_accuracy


def test_perfect_grouping_scores_one_whatever_the_labels():
    truth = np.array(["a", "a", "b", "c", "c"])
    assert grouping_accuracy(np.array([7, 7, 3, 9, 9]), truth) == 1.0


def test_a_merged_group_scores_none_of_its_lines():
    truth = np.array(["a", "a", "b", "c"])
    # a and b merged into group 1: those three lines are wrong, c is right
    assert grouping_accuracy(np.array([1, 1, 1, 2]), truth) == 0.25


def test_a_split_group_scores_none_of_its_lines():
    truth = np.array(["a", "a", "a", "b"])
    assert grouping_accuracy(np.array([1, 1, 2, 3]), truth) == 0.25
