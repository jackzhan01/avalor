"""Variant identities keep their own labels and public answer space."""
from collections import Counter

import pytest

from vbench.agent_pairs import INSTRUCTION_ZH, pair_instruction
from vbench.private_labels import build_label_v3, roster_v2_errors
from vbench.validate import ROLE_SIDE, schema_errors


def roster():
    roles = ['percival', 'mordred', 'loyal', 'loyal', 'loyal',
             'merlin', 'wallbreaker', 'swordholder', 'assassin', 'morgana']
    return {
        'schema': 'vbench.private_roster/2', 'game_id': 'game-0123456789',
        'player_count': 10, 'composition': dict(Counter(roles)),
        'seats': [{'seat': i, 'role': role, 'side': ROLE_SIDE[role],
                   'verification': 'verified', 'sources': [{'kind': 'roster_crop'}],
                   'consistency': {'checked_times': [1, 2], 'agree': True}}
                  for i, role in enumerate(roles, 1)],
        'end_of_video_reveal': {'available': False, 'note': 'synthetic'}, 'notes': [],
    }


def test_variant_labels_survive_validation_and_export_without_coercion():
    r = roster()
    assert not schema_errors('private_roster', r)
    assert not roster_v2_errors(r)
    label = build_label_v3(r, 'p3full-' + '0' * 16, '0' * 64, 'accepted')
    assert not schema_errors('agent_label', label)
    assert label['seats']['7']['role'] == 'wallbreaker'
    assert label['seats']['7']['side'] == 'evil'
    assert label['seats']['8']['role'] == 'swordholder'
    assert label['seats']['8']['side'] == 'good'
    assert {'wallbreaker', 'swordholder'} <= set(label['role_enum'])
    assert label['scoring']['verified_seats'] == 10


def test_standard_exports_keep_the_original_answer_space():
    assert pair_instruction({}) == INSTRUCTION_ZH
    label = build_label_v3(None, 'p3full-' + '0' * 16, '0' * 64, 'accepted')
    assert label['role_enum'] == ['assassin', 'loyal', 'merlin', 'minion',
                                  'mordred', 'morgana', 'oberon', 'percival']


def test_variant_instruction_uses_verified_public_composition_only():
    comp = roster()['composition']
    text = pair_instruction({'role_composition': comp})
    assert '执剑人' in text and '破壁人' in text
    assert '奥伯伦' not in text
    with pytest.raises(ValueError, match='verified public'):
        pair_instruction({'role_composition': comp, 'unverified': ['role_composition']})
